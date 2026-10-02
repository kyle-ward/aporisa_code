// Harness → L3 projection (DEVELOPMENT_PLAN.md 10.3): live thread events become UI items and
// notifications, and session files become the same turns when a thread is reopened. Both
// paths share the tool-item builders so a resumed thread looks like it did live.
import type { CommandAction, FileChange, Item, ItemStatus, Notification, Turn } from "../app-protocol/index.ts";
import { classifyCommand, parsePatch, type ThreadEvent, type TimedSessionLine, type ToolDetails, type TurnOutcome } from "../harness/index.ts";
import type { OutputItem, ToolOutput } from "../protocol/index.ts";

type Emit = (notification: Notification) => void;

function parseArguments(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function patchChanges(patch: string): FileChange[] {
  try {
    return parsePatch(patch).map((hunk) =>
      hunk.type === "update" && hunk.movePath !== null
        ? { path: hunk.path, kind: "update", movePath: hunk.movePath }
        : { path: hunk.path, kind: hunk.type },
    );
  } catch {
    return [];
  }
}

export function outputText(output: ToolOutput): string {
  return typeof output === "string" ? output : output.map((part) => (part.type === "input_text" ? part.text : "[image]")).join("\n");
}

/** The item for a tool call that just started. */
export function toolItem(callId: string, name: string, argumentsText: string): Item {
  const args = parseArguments(argumentsText);
  const string = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  switch (name) {
    case "exec_command": {
      const command = string("cmd");
      return {
        type: "commandExecution",
        id: callId,
        command,
        cwd: string("workdir"),
        actions: classifyCommand(command) as CommandAction[],
        status: "running",
        exitCode: null,
        durationMs: null,
        sandboxed: null,
        escalated: args.sandbox_permissions === "require_escalated",
        output: "",
        sessionId: null,
      };
    }
    case "write_stdin":
      return { type: "stdinInteraction", id: callId, sessionId: typeof args.session_id === "number" ? args.session_id : 0, chars: string("chars"), status: "running", exitCode: null, output: "" };
    case "apply_patch":
      return { type: "fileChange", id: callId, changes: patchChanges(string("input")), patch: string("input"), status: "running", message: null };
    case "update_plan":
      return {
        type: "plan",
        id: callId,
        explanation: typeof args.explanation === "string" ? args.explanation : null,
        plan: Array.isArray(args.plan) ? (args.plan as { step: string; status: "pending" | "in_progress" | "completed" }[]) : [],
      };
    case "view_image":
      return { type: "imageView", id: callId, path: string("path"), status: "running" };
    default:
      return { type: "toolCall", id: callId, name, status: "running", output: "" };
  }
}

/** The finished item, from the harness's details (absent when the call never ran). */
export function completeToolItem(item: Item, done: { success: boolean; details?: ToolDetails; output: string; declined: boolean }): Item {
  const failed: ItemStatus = done.declined ? "declined" : "failed";
  const status = (ok: boolean): ItemStatus => (done.declined ? "declined" : ok ? "completed" : "failed");
  const details = done.details;
  switch (item.type) {
    case "commandExecution":
      if (details?.kind !== "command") return { ...item, status: failed, output: done.output };
      return {
        ...item,
        cwd: details.cwd,
        actions: details.actions,
        exitCode: details.exitCode,
        durationMs: Math.round(details.wallTimeMs),
        sandboxed: details.sandboxed,
        escalated: details.escalated,
        output: details.output,
        sessionId: details.sessionId,
        // A command still running in the background (session id) did not fail.
        status: details.exitCode === null ? "completed" : status(details.exitCode === 0),
      };
    case "stdinInteraction":
      if (details?.kind !== "stdin") return { ...item, status: failed, output: done.output };
      return { ...item, exitCode: details.exitCode, output: details.output, status: details.exitCode === null ? "completed" : status(details.exitCode === 0) };
    case "fileChange":
      if (details?.kind !== "patch") return { ...item, status: failed, message: done.output };
      return { ...item, changes: details.changes, patch: details.patch, status: "completed", message: null };
    case "plan":
      return details?.kind === "plan" ? { ...item, plan: details.plan, explanation: details.explanation ?? null } : item;
    case "imageView":
      return { ...item, status: status(done.success) };
    case "toolCall":
      return { ...item, status: status(done.success), output: done.output };
    default:
      return item;
  }
}

function messageText(item: Extract<OutputItem, { type: "message" }>): string {
  return item.content.map((part) => part.text).join("");
}

function reasoningText(item: Extract<OutputItem, { type: "reasoning" }>): string {
  const content = (item.content ?? []).map((part) => part.text).join("");
  return content !== "" ? content : item.summary.map((part) => part.text).join("\n\n");
}

function applyOutcome(turn: Turn, outcome: TurnOutcome, completedAt: string): void {
  turn.status = outcome.status;
  turn.error = outcome.error ? { code: outcome.error.code, message: outcome.error.message } : null;
  turn.truncated = outcome.truncated === true;
  turn.completedAt = completedAt;
  for (const [index, item] of turn.items.entries()) {
    if ((item.type === "agentMessage" || item.type === "reasoning") && item.status === "running") turn.items[index] = { ...item, status: "completed" };
    else if ("status" in item && item.status === "running" && item.type !== "agentMessage" && item.type !== "reasoning") {
      turn.items[index] = { ...item, status: "failed" } as Item;
    }
  }
}

function emptyTurn(id: string, startedAt: string): Turn {
  return { id, startedAt, completedAt: null, status: "running", error: null, truncated: false, items: [] };
}

/** Live projection of one thread's events. */
export class LiveProjector {
  readonly turns: Turn[];
  private readonly threadId: string;
  private readonly emit: Emit;
  private pendingInput: { text: string; images: string[] } | null = null;
  private readonly declined = new Set<string>();
  private compactions = 0;
  private now: () => string;

  constructor(threadId: string, emit: Emit, history: Turn[] = [], now: () => string = () => new Date().toISOString()) {
    this.threadId = threadId;
    this.emit = emit;
    this.turns = history;
    this.now = now;
  }

  /** The user's input for the turn about to start (turn.started carries only its id). */
  expectTurn(text: string, images: string[]): void {
    this.pendingInput = { text, images };
  }

  private turn(turnId: string | null): Turn | undefined {
    return turnId === null ? undefined : this.turns.find((turn) => turn.id === turnId);
  }

  private find(turn: Turn, id: string): number {
    return turn.items.findIndex((item) => item.id === id);
  }

  private replace(turn: Turn, index: number, item: Item): void {
    turn.items[index] = item;
    this.emit({ method: "item/completed", params: { threadId: this.threadId, turnId: turn.id, item } });
  }

  private add(turn: Turn, item: Item): void {
    turn.items.push(item);
    this.emit({ method: "item/started", params: { threadId: this.threadId, turnId: turn.id, item } });
  }

  handle(event: ThreadEvent): void {
    switch (event.type) {
      case "turn.started": {
        const turn = emptyTurn(event.turnId, this.now());
        if (this.pendingInput) {
          turn.items.push({ type: "userMessage", id: `user-${event.turnId}`, text: this.pendingInput.text, images: this.pendingInput.images });
          this.pendingInput = null;
        }
        this.turns.push(turn);
        this.emit({ method: "turn/started", params: { threadId: this.threadId, turn } });
        return;
      }
      case "item.started": {
        const turn = this.turn(event.turnId);
        if (!turn) return;
        if (event.kind === "message") this.add(turn, { type: "agentMessage", id: event.itemId, text: "", phase: null, status: "running" });
        else if (event.kind === "reasoning") this.add(turn, { type: "reasoning", id: event.itemId, text: "", durationMs: null, status: "running" });
        return;
      }
      case "item.delta": {
        const turn = this.turn(event.turnId);
        if (!turn || event.kind === "arguments") return;
        const index = this.find(turn, event.itemId);
        const item = turn.items[index];
        if (!item || (item.type !== "agentMessage" && item.type !== "reasoning")) return;
        turn.items[index] = { ...item, text: item.text + event.delta };
        this.emit({ method: "item/delta", params: { threadId: this.threadId, turnId: turn.id, itemId: event.itemId, kind: event.kind, delta: event.delta } });
        return;
      }
      case "item.completed": {
        const turn = this.turn(event.turnId);
        if (!turn) return;
        const index = this.find(turn, event.item.id);
        if (index < 0) return;
        if (event.item.type === "message") {
          this.replace(turn, index, { type: "agentMessage", id: event.item.id, text: messageText(event.item), phase: event.item.phase ?? null, status: "completed" });
        } else if (event.item.type === "reasoning") {
          this.replace(turn, index, { type: "reasoning", id: event.item.id, text: reasoningText(event.item), durationMs: event.durationMs ?? null, status: "completed" });
        }
        return;
      }
      case "tool.started": {
        const turn = this.turn(event.turnId);
        if (turn) this.add(turn, toolItem(event.callId, event.name, event.arguments));
        return;
      }
      case "approval.resolved":
        if (!event.approved) this.declined.add(event.callId);
        return;
      case "tool.completed": {
        const turn = this.turn(event.turnId);
        if (!turn) return;
        const index = this.find(turn, event.callId);
        const item = turn.items[index];
        if (!item) return;
        this.replace(
          turn,
          index,
          completeToolItem(item, { success: event.success, ...(event.details ? { details: event.details } : {}), output: outputText(event.output), declined: this.declined.has(event.callId) }),
        );
        return;
      }
      case "compaction.started": {
        this.compactions += 1;
        let turn = this.turn(event.turnId);
        if (!turn) {
          turn = emptyTurn(`compaction-${this.compactions}-${Date.now()}`, this.now());
          this.turns.push(turn);
          this.emit({ method: "turn/started", params: { threadId: this.threadId, turn } });
        }
        this.add(turn, { type: "compaction", id: `compaction-${this.compactions}`, reason: event.reason, status: "running", tokensBefore: event.tokens, tokensAfter: null });
        return;
      }
      case "compaction.completed": {
        const turn = this.turns.findLast((candidate) => candidate.items.some((item) => item.id === `compaction-${this.compactions}`));
        if (!turn) return;
        const index = this.find(turn, `compaction-${this.compactions}`);
        const item = turn.items[index];
        if (item?.type !== "compaction") return;
        this.replace(turn, index, { ...item, status: event.compacted ? "completed" : "failed", tokensAfter: event.compacted ? event.tokensAfter : null });
        if (event.turnId === null) {
          turn.status = event.compacted ? "completed" : "failed";
          turn.completedAt = this.now();
          if (!event.compacted && event.error) turn.error = { code: "compaction_failed", message: event.error };
          this.emit({ method: "turn/completed", params: { threadId: this.threadId, turn } });
        }
        return;
      }
      case "turn.completed": {
        const turn = this.turn(event.turnId);
        if (!turn) return;
        applyOutcome(turn, event.outcome, this.now());
        this.emit({ method: "turn/completed", params: { threadId: this.threadId, turn } });
        return;
      }
      default:
        return;
    }
  }
}

/** Turns rebuilt from a session file (opening a thread that is not loaded). */
export function projectSession(lines: readonly TimedSessionLine[], running = false): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  const calls = new Map<string, { turn: Turn; index: number }>();
  const fallbackOutputs = new Map<string, string>();
  const declined = new Set<string>();
  // A tool line is written when the call finishes, which can be before the call item itself
  // (output items are committed when their response ends).
  const finished = new Map<string, Extract<TimedSessionLine, { type: "tool" }>["payload"]>();
  const complete = (item: Item, payload: Extract<TimedSessionLine, { type: "tool" }>["payload"]): Item =>
    completeToolItem(item, {
      success: payload.success,
      ...(payload.details ? { details: payload.details } : {}),
      output: fallbackOutputs.get(payload.callId) ?? "",
      declined: declined.has(payload.callId),
    });
  let compactions = 0;

  for (const line of lines) {
    if (line.type === "turn") {
      const payload = line.payload as { turnId?: string; event?: string; outcome?: TurnOutcome };
      if (payload.event === "started" && typeof payload.turnId === "string") {
        current = emptyTurn(payload.turnId, line.timestamp);
        turns.push(current);
      } else if (payload.event === "completed" && payload.outcome) {
        const turn = turns.find((candidate) => candidate.id === payload.turnId);
        if (turn) applyOutcome(turn, payload.outcome, line.timestamp);
      }
      continue;
    }
    if (line.type === "approval") {
      const payload = line.payload as { callId?: string; decision?: string; approved?: boolean };
      if (typeof payload.callId === "string" && (payload.decision === "denied" || payload.approved === false)) declined.add(payload.callId);
      continue;
    }
    if (line.type === "compacted") {
      compactions += 1;
      const item: Item = { type: "compaction", id: `compaction-${compactions}`, reason: line.payload.reason, status: "completed", tokensBefore: 0, tokensAfter: null };
      if (current && line.payload.turnId === current.id) current.items.push(item);
      else turns.push({ ...emptyTurn(`compaction-${compactions}`, line.timestamp), status: "completed", completedAt: line.timestamp, items: [item] });
      continue;
    }
    if (line.type === "tool") {
      const entry = calls.get(line.payload.callId);
      if (!entry) {
        finished.set(line.payload.callId, line.payload);
        continue;
      }
      entry.turn.items[entry.index] = complete(entry.turn.items[entry.index] as Item, line.payload);
      calls.delete(line.payload.callId);
      continue;
    }
    if (line.type !== "item" || !current) continue;
    const item = line.payload.item;
    if (item.type === "message" && item.role === "user") {
      if (current.items.some((existing) => existing.type === "userMessage")) continue;
      const text = item.content.map((part) => (part.type === "input_image" ? "" : part.text)).join("");
      const images = item.content.flatMap((part) => (part.type === "input_image" ? [part.image_url] : []));
      current.items.push({ type: "userMessage", id: `user-${current.id}`, text, images });
    } else if (item.type === "message" && item.role === "assistant") {
      current.items.push({ type: "agentMessage", id: item.id ?? `message-${current.items.length}`, text: item.content.map((part) => ("text" in part ? part.text : "")).join(""), phase: item.phase ?? null, status: "completed" });
    } else if (item.type === "reasoning") {
      const text = (item.content ?? []).map((part) => part.text).join("") || item.summary.map((part) => part.text).join("\n\n");
      current.items.push({ type: "reasoning", id: item.id ?? `reasoning-${current.items.length}`, text, durationMs: line.payload.durationMs ?? null, status: "completed" });
    } else if (item.type === "function_call") {
      const done = finished.get(item.call_id);
      const started = toolItem(item.call_id, item.name, item.arguments);
      current.items.push(done ? complete(started, done) : started);
      if (!done) calls.set(item.call_id, { turn: current, index: current.items.length - 1 });
      finished.delete(item.call_id);
    } else if (item.type === "function_call_output") {
      fallbackOutputs.set(item.call_id, outputText(item.output));
    }
  }
  // Calls without a tool line (older sessions, crashes): finish them from the model-facing output.
  for (const [callId, entry] of calls) {
    entry.turn.items[entry.index] = completeToolItem(entry.turn.items[entry.index] as Item, {
      success: false,
      output: fallbackOutputs.get(callId) ?? "",
      declined: declined.has(callId),
    });
  }
  for (const [index, turn] of turns.entries()) {
    if (turn.status === "running" && !(running && index === turns.length - 1)) turn.status = "interrupted";
  }
  return turns;
}
