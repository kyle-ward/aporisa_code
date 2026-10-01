// exec_command and write_stdin, after codex's unified exec (core/src/tools/handlers/
// shell_spec.rs, core/src/tools/context.rs). Pipes instead of a PTY (FD-06).
import type { ProcessChunk } from "../../host/index.ts";
import { resolve } from "../paths.ts";
import { approxTokensFromBytes, byteBudget, byteLength, truncateText, withAllowance } from "./truncate.ts";
import { declined, ToolError, type ToolContext, type ToolHandler, type ToolResult } from "./types.ts";

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

export const execCommandTool: ToolHandler = {
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
    if (context.approve && !(await context.approve({ kind: "command", command, cwd }))) return declined("to run this command");
    const session = await context.processes.start({ command, cwd });
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
      details: { kind: "command", command, cwd, exitCode: chunk.exitCode, sessionId: chunk.exitCode === null ? session.id : null, wallTimeMs: chunk.wallTimeMs },
    };
  },
};

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
