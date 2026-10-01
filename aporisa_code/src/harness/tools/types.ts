// Tool handler contract (DEVELOPMENT_PLAN.md section 5).
import type { Host, ProcessManager } from "../../host/index.ts";
import type { FunctionTool, ToolOutput, TruncationPolicy } from "../../protocol/index.ts";

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  step: string;
  status: PlanStatus;
}

export interface FileChange {
  /** Path as written in the patch (relative paths resolve against the turn cwd). */
  path: string;
  kind: "add" | "update" | "delete";
  /** Destination of an update that also moves the file. */
  movePath?: string;
}

/** What the user is asked to allow before a side effect (F2 stopgap, FD-07; F3 replaces it). */
export type ApprovalRequest =
  | { kind: "command"; command: string; cwd: string }
  | { kind: "patch"; cwd: string; changes: FileChange[] };

/** Structured facts about a call, for events and the session record (never sent to the model). */
export type ToolDetails =
  | { kind: "command"; command: string; cwd: string; exitCode: number | null; sessionId: number | null; wallTimeMs: number }
  | { kind: "stdin"; sessionId: number; exitCode: number | null; wallTimeMs: number }
  | { kind: "patch"; changes: FileChange[] }
  | { kind: "plan"; explanation?: string; plan: PlanItem[] }
  | { kind: "image"; path: string };

export interface ToolContext {
  host: Host;
  /** Absolute working directory of the turn. */
  cwd: string;
  /** The thread's process sessions (exec_command, write_stdin). */
  processes: ProcessManager;
  /** The model's policy for tool output in history. */
  truncation: TruncationPolicy;
  /** Turn cancellation: stops waiting on processes (the thread terminates them). */
  signal?: AbortSignal;
  /** Asked before a command or patch runs; absent means allowed. */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface ToolResult {
  /** What the model sees, before history truncation. */
  output: ToolOutput;
  success: boolean;
  /** The untruncated text, kept in the session record when `output` was shortened. */
  fullOutput?: string;
  details?: ToolDetails;
}

export interface ToolHandler {
  readonly spec: FunctionTool;
  /** May run concurrently with other parallel tools of the same response (codex rules). */
  readonly parallel: boolean;
  /** `args` has already been checked against `spec.parameters`. */
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** A failed call whose explanation goes back to the model; the turn continues. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function declined(what: string): ToolResult {
  return { output: `The user declined ${what}. Do not retry it; ask the user how to proceed if it is needed.`, success: false };
}
