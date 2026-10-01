// Terminal rendering of thread events. Text goes to stdout; activity and diagnostics to
// stderr, so `aporisa exec` output can be piped. --json prints the events as JSONL instead.
import type { ApprovalRequest, ThreadEvent, ToolDetails } from "../harness/index.ts";

export interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const processOutput: Output = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function oneLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function describeCall(name: string, args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (name === "exec_command" && typeof parsed.cmd === "string") return `$ ${oneLine(parsed.cmd)}`;
    if (name === "write_stdin") return `write_stdin #${String(parsed.session_id)}${typeof parsed.chars === "string" && parsed.chars !== "" ? ` ${JSON.stringify(parsed.chars)}` : " (wait)"}`;
    if (name === "view_image" && typeof parsed.path === "string") return `view_image ${parsed.path}`;
    if (name === "apply_patch") return "apply_patch";
    if (name === "update_plan") return "update_plan";
  } catch {
    // Show the raw name below.
  }
  return name;
}

function describeResult(details: ToolDetails | undefined, success: boolean): string {
  if (!details) return success ? "ok" : "failed";
  switch (details.kind) {
    case "command":
    case "stdin":
      return details.exitCode === null
        ? `still running (session ${details.sessionId}, ${(details.wallTimeMs / 1000).toFixed(1)}s)`
        : `exit ${details.exitCode} (${(details.wallTimeMs / 1000).toFixed(1)}s)`;
    case "patch":
      return details.changes.map((change) => `${change.kind === "add" ? "A" : change.kind === "delete" ? "D" : "M"} ${change.movePath ?? change.path}`).join(", ");
    case "plan":
      return details.plan.map((item) => `${item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]"} ${item.step}`).join("  ");
    case "image":
      return `viewed ${details.path}`;
  }
}

export interface RenderOptions {
  json: boolean;
  showReasoning: boolean;
  color: boolean;
}

/** Returns a listener that renders events for a person (or as JSONL). */
export function renderer(output: Output, options: RenderOptions): (event: ThreadEvent) => void {
  const dim = (text: string) => (options.color ? `${DIM}${text}${RESET}` : text);
  let midLine = false;
  const endLine = () => {
    if (midLine) output.out("\n");
    midLine = false;
  };
  return (event) => {
    if (options.json) {
      output.out(`${JSON.stringify(event)}\n`);
      return;
    }
    switch (event.type) {
      case "thread.started":
        output.err(dim(`[Aporisa Code] [INFO] ${event.resumed ? "resumed" : "started"} thread ${event.threadId} (${event.model}, effort ${event.effort}) in ${event.cwd}\n`));
        break;
      case "item.delta":
        if (event.kind === "text") {
          output.out(event.delta);
          midLine = !event.delta.endsWith("\n");
        } else if (event.kind === "reasoning" && options.showReasoning) {
          output.err(dim(event.delta));
        }
        break;
      case "item.completed":
        if (event.item.type === "message") endLine();
        if (event.item.type === "reasoning" && options.showReasoning) output.err("\n");
        break;
      case "tool.started":
        endLine();
        output.err(dim(`▶ ${describeCall(event.name, event.arguments)}\n`));
        break;
      case "tool.completed":
        output.err(dim(`  ${event.success ? "✓" : "✗"} ${describeResult(event.details, event.success)}\n`));
        break;
      case "effort.changed":
        output.err(dim(`[Aporisa Code] [INFO] effort is now ${event.effort}\n`));
        break;
      case "warning":
        endLine();
        output.err(`[Aporisa Code] [INFO] ${event.message}\n`);
        break;
      case "turn.completed": {
        endLine();
        const { outcome } = event;
        const usage = outcome.usage;
        const summary = `${outcome.requests} requests, ${usage.inputTokens} input (${usage.cachedTokens} cached), ${usage.outputTokens} output tokens`;
        if (outcome.status === "failed") output.err(`ERROR: turn failed (${outcome.error?.code}): ${outcome.error?.message} [${summary}]\n`);
        else output.err(dim(`[Aporisa Code] [INFO] turn ${outcome.status}${outcome.truncated ? ", answer cut at the output limit" : ""}: ${summary}\n`));
        break;
      }
      default:
        break;
    }
  };
}

/** The approval question shown in the terminal (FD-07). */
export function approvalQuestion(request: ApprovalRequest): string {
  if (request.kind === "command") return `Run in ${request.cwd}?\n  $ ${request.command}\n[y/N] `;
  const files = request.changes.map((change) => `  ${change.kind} ${change.path}${change.movePath ? ` -> ${change.movePath}` : ""}`).join("\n");
  return `Apply this patch in ${request.cwd}?\n${files}\n[y/N] `;
}
