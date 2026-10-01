// Tool handler contract (DEVELOPMENT_PLAN.md section 5).
import type { Host, ProcessManager } from "../../host/index.ts";
import type { FunctionTool, ToolOutput, TruncationPolicy } from "../../protocol/index.ts";
import type { CommandReason, SafetyPolicy, SessionRules } from "../safety/index.ts";

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

/** What the user is asked to allow (F3). */
export type ApprovalRequest =
  | {
      kind: "command";
      command: string;
      cwd: string;
      /** escalation: the model asks to run outside the sandbox; dangerous: e.g. a forced rm;
       * untrusted: the policy asks for every non-read-only command; sandbox_denied: rerun
       * outside the sandbox after a denial (untrusted policy). */
      reason: CommandReason | "sandbox_denied";
      /** Whether the command will run inside the sandbox if approved. */
      sandboxed: boolean;
      /** The model's one-line question, when it gave one. */
      justification?: string;
      /** What "allow for this session" remembers; null when it cannot be offered. */
      rememberPrefixes: string[][] | null;
    }
  | {
      kind: "patch";
      cwd: string;
      changes: FileChange[];
      reason: "outside_workspace" | "untrusted";
      /** Real paths that need the approval. */
      paths: string[];
    };

export type ApprovalDecision = "approved" | "approved_for_session" | "denied";

/** The thread's safety state, shared by its tools. */
export interface SafetyContext {
  policy: SafetyPolicy;
  rules: SessionRules;
}

/** Structured facts about a call, for events and the session record (never sent to the model). */
export type ToolDetails =
  | { kind: "command"; command: string; cwd: string; exitCode: number | null; sessionId: number | null; wallTimeMs: number; sandboxed: boolean; escalated: boolean }
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
  /**
   * Sandbox and approval policy. Absent means no sandbox and no questions (tests and
   * trusted callers only).
   */
  safety?: SafetyContext;
  /** Asks the user. Absent: anything that needs approval is refused. */
  approve?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
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

/** Asks through the context; without anyone to ask, the answer is no. */
export async function askUser(context: ToolContext, request: ApprovalRequest): Promise<ApprovalDecision | "unavailable"> {
  if (!context.approve) return "unavailable";
  return context.approve(request);
}

export function unavailable(what: string): ToolResult {
  return {
    output: `${what} needs the user's approval, but nobody can be asked in this session (non-interactive run), so it was not done. Work within the current permissions or tell the user what you need.`,
    success: false,
  };
}
