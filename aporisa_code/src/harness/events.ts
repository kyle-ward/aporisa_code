// Events the harness emits (DEVELOPMENT_PLAN.md 6.6, FD-04). Organized after codex's
// app-server Thread / Turn / Item; not frozen until the L3 contract before F4. Events are
// plain JSON so they can cross IPC and be written as JSONL by the CLI.
import type { OutputItem, ReasoningEffort, StreamErrorCode, ToolOutput, Usage } from "../protocol/index.ts";
import type { ApprovalDecision, ApprovalRequest, ToolDetails } from "./tools/index.ts";

export type TurnStatus = "completed" | "interrupted" | "failed";

export type TurnFailureCode =
  | StreamErrorCode
  | "context_window_exceeded"
  | "max_requests"
  | "request_rejected"
  | "transport_error"
  | "protocol_error";

export interface TurnOutcome {
  status: TurnStatus;
  /** Model requests made in this turn. */
  requests: number;
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number };
  /** Text of the last assistant message, if any. */
  lastMessage: string | null;
  error?: { code: TurnFailureCode | string; message: string };
  /** The last response hit max_output_tokens without calling a tool. */
  truncated?: boolean;
}

export type ThreadEvent =
  | {
      type: "thread.started";
      threadId: string;
      model: string;
      cwd: string;
      effort: ReasoningEffort;
      resumed: boolean;
      sessionPath: string | null;
      safety: { sandbox: string; approval: string; network: boolean };
    }
  | { type: "turn.started"; turnId: string }
  | { type: "item.started"; turnId: string; itemId: string; kind: OutputItem["type"]; name?: string }
  | { type: "item.delta"; turnId: string; itemId: string; kind: "text" | "reasoning" | "arguments"; delta: string }
  | { type: "item.completed"; turnId: string; item: OutputItem }
  | { type: "tool.started"; turnId: string; callId: string; name: string; arguments: string }
  | { type: "tool.completed"; turnId: string; callId: string; name: string; success: boolean; output: ToolOutput; details?: ToolDetails }
  | { type: "approval.requested"; turnId: string; callId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; turnId: string; callId: string; approved: boolean; decision: ApprovalDecision }
  | { type: "effort.changed"; turnId: string; effort: ReasoningEffort; via: "configuration_update" | "baseline" }
  | {
      type: "response.completed";
      turnId: string;
      requestIndex: number;
      status: "completed" | "incomplete" | "failed";
      usage: Usage | null;
      /** Until the first output item opened: close to time to first token. */
      timeToFirstOutputMs: number | null;
      durationMs: number;
    }
  | { type: "warning"; turnId?: string; message: string }
  | { type: "turn.completed"; turnId: string; outcome: TurnOutcome };

export type ThreadListener = (event: ThreadEvent) => void;
