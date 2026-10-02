// How a turn is shown (DEVELOPMENT_PLAN.md 10.4, after the user's ChatGPT.app screenshots):
// the final answer stays visible; everything before it is the "process" behind a
// "Worked for …" toggle: commentary, "Thought for …" rows, and activity groups where
// consecutive tool calls collapse into one summary line ("Read files, ran commands").
// Pure logic, no DOM, so it is tested directly.
import type { Item, Turn } from "../../app-protocol/types.ts";

export type AgentMessageItem = Extract<Item, { type: "agentMessage" }>;
export type ReasoningItem = Extract<Item, { type: "reasoning" }>;
export type PlanItemView = Extract<Item, { type: "plan" }>;
export type CompactionItem = Extract<Item, { type: "compaction" }>;
export type ToolItem = Extract<Item, { type: "commandExecution" | "stdinInteraction" | "fileChange" | "imageView" | "toolCall" }>;

export type ProcessBlock =
  | { kind: "message"; id: string; item: AgentMessageItem }
  | { kind: "thought"; id: string; item: ReasoningItem }
  | { kind: "activity"; id: string; items: ToolItem[] }
  | { kind: "plan"; id: string; item: PlanItemView }
  | { kind: "compaction"; id: string; item: CompactionItem };

export interface TurnLayout {
  user: Extract<Item, { type: "userMessage" }> | null;
  process: ProcessBlock[];
  answer: AgentMessageItem | null;
}

const TOOL_TYPES = new Set<Item["type"]>(["commandExecution", "stdinInteraction", "fileChange", "imageView", "toolCall"]);

export function isToolItem(item: Item): item is ToolItem {
  return TOOL_TYPES.has(item.type);
}

/**
 * The answer is the last agent message with no tool activity after it, once it is known
 * to be final: a completed turn, or a message the model marked final_answer.
 */
function findAnswer(turn: Turn): AgentMessageItem | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index] as Item;
    if (item.type === "agentMessage") {
      if (item.text.trim() === "") continue;
      const settled = turn.status !== "running" || item.phase === "final_answer";
      return settled && item.status === "completed" ? item : null;
    }
    if (isToolItem(item) || item.type === "plan") return null;
  }
  return null;
}

export function layoutTurn(turn: Turn): TurnLayout {
  const user = turn.items.find((item): item is Extract<Item, { type: "userMessage" }> => item.type === "userMessage") ?? null;
  const answer = findAnswer(turn);
  const process: ProcessBlock[] = [];
  for (const item of turn.items) {
    if (item === user || item === answer) continue;
    if (isToolItem(item)) {
      const last = process[process.length - 1];
      if (last?.kind === "activity") last.items.push(item);
      else process.push({ kind: "activity", id: `activity-${item.id}`, items: [item] });
    } else if (item.type === "agentMessage") {
      if (item.text.trim() !== "") process.push({ kind: "message", id: item.id, item });
    } else if (item.type === "reasoning") {
      if (item.text.trim() !== "" || item.status === "running") process.push({ kind: "thought", id: item.id, item });
    } else if (item.type === "plan") {
      process.push({ kind: "plan", id: item.id, item });
    } else if (item.type === "compaction") {
      process.push({ kind: "compaction", id: item.id, item });
    }
  }
  return { user, process, answer };
}

export type SummaryPart = "read" | "readOne" | "search" | "list" | "run" | "runOne" | "edit" | "editOne" | "stdin" | "image" | "other";

/** The verbs of an activity group's summary line, in order of first appearance. */
export function summarize(items: readonly ToolItem[]): SummaryPart[] {
  const order: ("read" | "search" | "list" | "run" | "edit" | "stdin" | "image" | "other")[] = [];
  const add = (part: (typeof order)[number]) => {
    if (!order.includes(part)) order.push(part);
  };
  let reads = 0;
  let runs = 0;
  let edits = 0;
  for (const item of items) {
    switch (item.type) {
      case "commandExecution":
        for (const action of item.actions) {
          add(action.kind);
          if (action.kind === "read") reads += 1;
        }
        if (item.actions.some((action) => action.kind === "run")) runs += 1;
        break;
      case "fileChange":
        add("edit");
        edits += Math.max(1, item.changes.length);
        break;
      case "stdinInteraction":
        add("stdin");
        break;
      case "imageView":
        add("image");
        break;
      case "toolCall":
        add("other");
        break;
    }
  }
  return order.map((part) => (part === "read" && reads === 1 ? "readOne" : part === "run" && runs === 1 ? "runOne" : part === "edit" && edits === 1 ? "editOne" : part));
}

export type RowKind = "read" | "search" | "searchIn" | "list" | "listIn" | "run" | "add" | "update" | "delete" | "move" | "stdin" | "poll" | "image" | "tool";

export interface ActivityRow {
  /** Unique within the group. */
  key: string;
  item: ToolItem;
  kind: RowKind;
  values: Record<string, string>;
  /** What expanding the row shows. */
  detail: "shell" | "patch" | "output" | null;
}

const MAX_PATHS = 3;

function joinPaths(paths: string[]): string {
  return paths.length <= MAX_PATHS ? paths.join(", ") : `${paths.slice(0, MAX_PATHS).join(", ")} +${paths.length - MAX_PATHS}`;
}

/** One row per tool item (a patch: one row per changed file). */
export function activityRows(items: readonly ToolItem[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const item of items) {
    switch (item.type) {
      case "commandExecution": {
        const reads = item.actions.flatMap((action) => (action.kind === "read" ? [action.path] : []));
        const first = item.actions[0];
        if (item.actions.every((action) => action.kind === "read") && reads.length > 0) {
          rows.push({ key: item.id, item, kind: "read", values: { path: joinPaths(reads) }, detail: "shell" });
        } else if (first?.kind === "search" && item.actions.every((action) => action.kind !== "run")) {
          rows.push({ key: item.id, item, kind: first.path ? "searchIn" : "search", values: { query: first.query ?? "", path: first.path ?? "" }, detail: "shell" });
        } else if (first?.kind === "list" && item.actions.every((action) => action.kind !== "run")) {
          rows.push({ key: item.id, item, kind: first.path ? "listIn" : "list", values: { path: first.path ?? "" }, detail: "shell" });
        } else {
          rows.push({ key: item.id, item, kind: "run", values: { command: item.command.replace(/\s+/g, " ").trim() }, detail: "shell" });
        }
        break;
      }
      case "fileChange":
        if (item.changes.length === 0) rows.push({ key: item.id, item, kind: "update", values: { path: "…" }, detail: "patch" });
        for (const [index, change] of item.changes.entries()) {
          const kind: RowKind = change.movePath ? "move" : change.kind;
          rows.push({ key: `${item.id}-${index}`, item, kind, values: { path: change.path, target: change.movePath ?? "" }, detail: "patch" });
        }
        break;
      case "stdinInteraction":
        rows.push({ key: item.id, item, kind: item.chars === "" ? "poll" : "stdin", values: { id: String(item.sessionId) }, detail: "output" });
        break;
      case "imageView":
        rows.push({ key: item.id, item, kind: "image", values: { path: item.path }, detail: null });
        break;
      case "toolCall":
        rows.push({ key: item.id, item, kind: "tool", values: { name: item.name }, detail: item.output ? "output" : null });
        break;
    }
  }
  return rows;
}

/** Turn duration in ms (live turns: until `now`). */
export function turnDuration(turn: Turn, now: number): number {
  const start = Date.parse(turn.startedAt);
  const end = turn.completedAt ? Date.parse(turn.completedAt) : now;
  return Math.max(0, end - start);
}

const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.*)$/;

/** The section of an apply_patch body for one file; the whole patch when it is not found. */
export function filePatch(patch: string, path: string): string {
  const lines = patch.split("\n");
  const start = lines.findIndex((line) => FILE_HEADER.exec(line)?.[2]?.trim() === path);
  if (start < 0) return patch;
  let end = start + 1;
  while (end < lines.length && !FILE_HEADER.test(lines[end] as string) && (lines[end] as string) !== "*** End Patch") end += 1;
  return lines.slice(start, end).join("\n");
}

/** Lines of a patch with their role, for coloring. */
export function patchLines(patch: string): { text: string; role: "add" | "remove" | "header" | "context" }[] {
  return patch.split("\n").map((text) => ({
    text,
    role: text.startsWith("***") || text.startsWith("@@") ? "header" : text.startsWith("+") ? "add" : text.startsWith("-") ? "remove" : "context",
  }));
}
