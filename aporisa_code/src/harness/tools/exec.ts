// exec_command and write_stdin, after codex's unified exec (core/src/tools/handlers/
// shell_spec.rs, core/src/tools/context.rs). Pipes instead of a PTY (FD-06); sandbox and
// approvals per the thread's safety policy (F3).
import type { ProcessChunk } from "../../host/index.ts";
import { resolve } from "../paths.ts";
import { approxTokensFromBytes, byteBudget, byteLength, truncateText, withAllowance } from "./truncate.ts";
import { assessCommand, likelySandboxDenied, sandboxSpec } from "../safety/index.ts";
import { askUser, declined, ToolError, unavailable, type ToolContext, type ToolHandler, type ToolResult } from "./types.ts";

export const DEFAULT_YIELD_MS = 10_000;
export const MIN_YIELD_MS = 250;
export const MAX_YIELD_MS = 30_000;
/** write_stdin with nothing to write is a poll: it waits longer by default. */
export const MIN_POLL_YIELD_MS = 5_000;
export const MAX_POLL_YIELD_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * The text the model sees: a header (wall time, exit code or session id, original size
 * when shortened) and the output. As in codex, the output gets the smaller of the
 * requested budget and the model's truncation policy, and header plus output stay within
 * the history allowance (1.2x the policy) so history does not truncate a second time.
 */
export function formatChunk(chunk: ProcessChunk, sessionId: number, maxOutputTokens: number, context: ToolContext): string {
  const budget = Math.min(maxOutputTokens * 4, byteBudget(context.truncation));
  const fits = chunk.omittedBytes === 0 && byteLength(chunk.output) <= budget;
  const allowance = byteBudget(withAllowance(context.truncation));
  const header = [`Wall time: ${(chunk.wallTimeMs / 1000).toFixed(4)} seconds`];
  header.push(chunk.exitCode === null ? `Process running with session ID ${sessionId}` : `Process exited with code ${chunk.exitCode}`);
  if (!fits) header.push(`Original token count: ${approxTokensFromBytes(chunk.totalBytes)}`);
  header.push("Output:");
  const headerText = header.join("\n");
  const bodyBudget = Math.max(0, Math.min(budget, allowance - byteLength(headerText) - 1));
  let body = chunk.output;
  // Like codex's response_text: shrink until the marker fits too.
  for (let limit = bodyBudget; byteLength(body) > bodyBudget; ) {
    body = truncateText(chunk.output, { mode: "bytes", limit });
    if (limit === 0) break;
    limit = Math.max(0, limit - Math.max(1, byteLength(body) - bodyBudget));
  }
  return `${headerText}\n${body}`;
}

function fullText(chunk: ProcessChunk, shown: string): string | undefined {
  return shown.endsWith(chunk.output) ? undefined : chunk.output;
}

export interface ExecCommandOptions {
  /** Offer `sandbox_permissions` and `justification` (a sandbox the user can lift on request). */
  escalation: boolean;
}

const ESCALATION_PARAMETERS = {
  sandbox_permissions: {
    type: "string",
    enum: ["use_default", "require_escalated"],
    description: "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` to run outside the sandbox (needs the user's approval).",
  },
  justification: {
    type: "string",
    description:
      'Only with "require_escalated": one short question asking the user to allow the command outside the sandbox, phrased by its purpose in the task, e.g. "Do you want to install the project\'s npm dependencies?"',
  },
};

const DENIAL_HINT: Record<string, string> = {
  "on-request":
    '[Aporisa Code] This failure looks like a sandbox restriction. If the command is needed, run it again with "sandbox_permissions": "require_escalated" and a justification.',
  never: "[Aporisa Code] This failure looks like a sandbox restriction. Approvals are off in this session, so the command cannot run outside the sandbox.",
};

/** exec_command after codex (shell_spec.rs), with the F3 sandbox and approvals. */
export function createExecCommandTool(options: ExecCommandOptions): ToolHandler {
  return {
    spec: {
      type: "function",
      name: "exec_command",
      description:
        "Runs a shell command and returns its output, or a session ID when the command is still running after yield_time_ms. Use write_stdin with that session ID to send input or to keep waiting. Output is plain text (no terminal); stdin is a pipe.",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Shell command to execute." },
          workdir: { type: "string", description: "Working directory for the command. Defaults to the turn cwd." },
          yield_time_ms: { type: "number", description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." },
          max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." },
          ...(options.escalation ? ESCALATION_PARAMETERS : {}),
        },
        required: ["cmd"],
        additionalProperties: false,
      },
    },
    parallel: true,

    async run(args, context) {
      const command = args.cmd as string;
      if (command.trim() === "") throw new ToolError("cmd must not be empty.");
      const cwd = typeof args.workdir === "string" ? resolve(context.cwd, args.workdir) : context.cwd;
      const escalate = args.sandbox_permissions === "require_escalated";
      const justification = typeof args.justification === "string" && args.justification.trim() !== "" ? args.justification.trim() : undefined;
      const safety = context.safety;

      let sandboxed = false;
      if (safety) {
        const assessment = assessCommand(safety.policy, safety.rules, command, escalate);
        if (assessment.action === "refuse") throw new ToolError(assessment.message);
        sandboxed = assessment.sandboxed;
        if (assessment.action === "ask") {
          const decision = await askUser(context, {
            kind: "command",
            command,
            cwd,
            reason: assessment.reason,
            sandboxed,
            ...(justification !== undefined ? { justification } : {}),
            rememberPrefixes: assessment.prefixes,
          });
          if (decision === "unavailable") return unavailable("This command");
          if (decision === "denied") return declined(sandboxed ? "to run this command" : "to run this command outside the sandbox");
          if (decision === "approved_for_session" && assessment.prefixes) safety.rules.rememberCommand(assessment.prefixes, !sandboxed);
        }
      }

      let result = await runCommand(command, cwd, sandboxed, escalate && !sandboxed, args, context);
      const details = result.details?.kind === "command" ? result.details : null;
      if (safety && sandboxed && details && likelySandboxDenied(safety.policy, details.exitCode, result.fullOutput ?? String(result.output))) {
        if (safety.policy.approval === "untrusted") {
          // codex asks to retry without the sandbox under the untrusted policy.
          const decision = await askUser(context, { kind: "command", command, cwd, reason: "sandbox_denied", sandboxed: false, rememberPrefixes: null });
          if (decision === "approved" || decision === "approved_for_session") result = await runCommand(command, cwd, false, true, args, context);
        } else {
          const hint = DENIAL_HINT[safety.policy.approval];
          if (hint && safety.policy.sandbox !== "danger-full-access") result = { ...result, output: `${String(result.output)}\n${hint}` };
        }
      }
      return result;
    },
  };
}

async function runCommand(command: string, cwd: string, sandboxed: boolean, escalated: boolean, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const policy = context.safety?.policy;
  const sandbox = sandboxed && policy ? sandboxSpec(policy) : null;
  const session = await context.processes.start({
    command,
    cwd,
    ...(sandbox ? { sandbox } : {}),
    ...(policy?.stripSecrets ? { stripSecrets: true } : {}),
  });
  const chunk = await session.read({
    yieldMs: clamp(args.yield_time_ms, DEFAULT_YIELD_MS, MIN_YIELD_MS, MAX_YIELD_MS),
    ...(context.signal ? { signal: context.signal } : {}),
  });
  const output = formatChunk(chunk, session.id, clamp(args.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS, 1, Number.MAX_SAFE_INTEGER), context);
  const full = fullText(chunk, output);
  return {
    output,
    success: chunk.exitCode === null || chunk.exitCode === 0,
    ...(full !== undefined ? { fullOutput: full } : {}),
    details: {
      kind: "command",
      command,
      cwd,
      exitCode: chunk.exitCode,
      sessionId: chunk.exitCode === null ? session.id : null,
      wallTimeMs: chunk.wallTimeMs,
      sandboxed: sandbox !== null,
      escalated,
    },
  };
}

/** No escalation parameters: the shape used without a sandbox the model could ask to lift. */
export const execCommandTool: ToolHandler = createExecCommandTool({ escalation: false });

export const writeStdinTool: ToolHandler = {
  spec: {
    type: "function",
    name: "write_stdin",
    description:
      "Writes characters to a running exec_command session and returns recent output. Send an empty string to wait for more output. \\u0003 (Ctrl-C) interrupts the process; \\u0004 (Ctrl-D) closes its stdin.",
    parameters: {
      type: "object",
      properties: {
        session_id: { type: "number", description: "Identifier of the running exec_command session." },
        chars: { type: "string", description: "Characters to write to stdin. Defaults to empty, which polls without writing." },
        yield_time_ms: { type: "number", description: "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms." },
        max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  parallel: true,

  async run(args, context) {
    const sessionId = args.session_id as number;
    const session = context.processes.get(sessionId);
    if (!session) throw new ToolError(`Unknown session ID ${sessionId}: the process has finished and was reported, or never existed.`);
    const chars = typeof args.chars === "string" ? args.chars : "";
    if (chars.length > 0) await session.write(chars);
    const yieldMs =
      chars.length > 0
        ? clamp(args.yield_time_ms, MIN_YIELD_MS, MIN_YIELD_MS, MAX_YIELD_MS)
        : clamp(args.yield_time_ms, MIN_POLL_YIELD_MS, MIN_POLL_YIELD_MS, MAX_POLL_YIELD_MS);
    const chunk = await session.read({ yieldMs, ...(context.signal ? { signal: context.signal } : {}) });
    const output = formatChunk(chunk, session.id, clamp(args.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS, 1, Number.MAX_SAFE_INTEGER), context);
    const full = fullText(chunk, output);
    return {
      output,
      success: chunk.exitCode === null || chunk.exitCode === 0,
      ...(full !== undefined ? { fullOutput: full } : {}),
      details: { kind: "stdin", sessionId, exitCode: chunk.exitCode, wallTimeMs: chunk.wallTimeMs },
    };
  },
};
