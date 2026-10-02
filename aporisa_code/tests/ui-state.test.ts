// F4 renderer logic without a DOM: turn layout (process vs. answer, activity groups and
// rows), the reducer over L3 notifications, the composer's send key and the dictionaries.
import { describe, expect, it } from "vitest";
import type { Item, Notification, ProjectInfo, ServerRequest, ThreadInfo, Turn } from "../src/app-protocol/types.ts";
import { DICTIONARIES, formatAge, formatDuration, translator, type MessageKey } from "../src/ui/i18n.ts";
import { isSendKey } from "../src/ui/keys.ts";
import { initialState, reducer, sidebarGroups, sortedThreads, type AppState } from "../src/ui/state/store.ts";
import { activityRows, filePatch, layoutTurn, patchLines, summarize, type RowKind, type SummaryPart, type ToolItem } from "../src/ui/state/turn-layout.ts";

function command(id: string, text: string, actions: Extract<Item, { type: "commandExecution" }>["actions"], extra: Partial<Extract<Item, { type: "commandExecution" }>> = {}): Item {
  return { type: "commandExecution", id, command: text, cwd: "/w", actions, status: "completed", exitCode: 0, durationMs: 5, sandboxed: true, escalated: false, output: "", sessionId: null, ...extra };
}

function message(id: string, text: string, phase: "commentary" | "final_answer" | null = null, status: "running" | "completed" = "completed"): Item {
  return { type: "agentMessage", id, text, phase, status };
}

function turn(items: Item[], status: Turn["status"] = "completed"): Turn {
  return { id: "t1", startedAt: "2026-10-01T00:00:00.000Z", completedAt: status === "running" ? null : "2026-10-01T00:00:12.000Z", status, error: null, truncated: false, items };
}

const user: Item = { type: "userMessage", id: "u", text: "fix it", images: [] };
const thinking: Item = { type: "reasoning", id: "r", text: "look first", durationMs: 2000, status: "completed" };
const read = command("x1", "cat a.ts b.ts", [{ kind: "read", path: "a.ts" }, { kind: "read", path: "b.ts" }]);
const search = command("x2", "rg -n foo src", [{ kind: "search", query: "foo", path: "src" }]);
const run = command("x3", "npm test", [{ kind: "run", command: "npm test" }], { exitCode: 1, status: "failed" });
const patch: Item = {
  type: "fileChange",
  id: "p",
  changes: [{ path: "a.ts", kind: "update" }, { path: "c.ts", kind: "add" }],
  patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: c.ts\n+hello\n*** End Patch",
  status: "completed",
  message: null,
};

describe("turn layout", () => {
  it("puts the final answer outside the process and groups consecutive tools", () => {
    const layout = layoutTurn(turn([user, thinking, message("c1", "I'll look.", "commentary"), read, search, message("c2", "Now edit."), patch, run, message("a", "Done.")]));
    expect(layout.user).toBe(user);
    expect(layout.answer?.id).toBe("a");
    expect(layout.process.map((block) => block.kind)).toEqual(["thought", "message", "activity", "message", "activity"]);
    const groups = layout.process.filter((block) => block.kind === "activity");
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([["x1", "x2"], ["p", "x3"]]);
  });

  it("has no answer while running unless the message is final, and none after a trailing tool", () => {
    expect(layoutTurn(turn([user, message("a", "partial")], "running")).answer).toBeNull();
    expect(layoutTurn(turn([user, message("a", "done", "final_answer")], "running")).answer?.id).toBe("a");
    expect(layoutTurn(turn([user, message("a", "streaming", "final_answer", "running")], "running")).answer).toBeNull();
    const interrupted = layoutTurn(turn([user, message("c", "looking"), read], "interrupted"));
    expect(interrupted.answer).toBeNull();
    expect(interrupted.process.map((block) => block.kind)).toEqual(["message", "activity"]);
  });

  it("drops empty reasoning but keeps a running thought", () => {
    const empty: Item = { type: "reasoning", id: "r0", text: "", durationMs: null, status: "completed" };
    const live: Item = { type: "reasoning", id: "r1", text: "", durationMs: null, status: "running" };
    expect(layoutTurn(turn([user, empty, live], "running")).process.map((block) => block.id)).toEqual(["r1"]);
  });

  it("summarizes a group in order of first appearance with singular forms", () => {
    expect(summarize([read, search, run] as ToolItem[])).toEqual(["read", "search", "runOne"]);
    const oneRead = command("x9", "cat a.ts", [{ kind: "read", path: "a.ts" }]);
    expect(summarize([oneRead, patch] as ToolItem[])).toEqual(["readOne", "edit"]);
  });

  it("makes one row per command and per changed file", () => {
    const rows = activityRows([read, search, patch, run] as ToolItem[]);
    expect(rows.map((row) => [row.kind, row.values])).toEqual([
      ["read", { path: "a.ts, b.ts" }],
      ["searchIn", { query: "foo", path: "src" }],
      ["update", { path: "a.ts", target: "" }],
      ["add", { path: "c.ts", target: "" }],
      ["run", { command: "npm test" }],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("cuts a patch down to one file and colors its lines", () => {
    expect(filePatch((patch as Extract<Item, { type: "fileChange" }>).patch, "c.ts")).toBe("*** Add File: c.ts\n+hello");
    expect(filePatch("garbage", "a.ts")).toBe("garbage");
    expect(patchLines("@@\n-a\n+b\n c").map((line) => line.role)).toEqual(["header", "remove", "add", "context"]);
  });
});

describe("reducer", () => {
  const info: ThreadInfo = { id: "th", title: "", cwd: "/w", projectId: null, scratch: false, model: "m", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: 1, loaded: true, running: false };
  const notify = (state: AppState, notification: Notification) => reducer(state, { type: "notification", notification });

  it("streams a turn and keeps streamed items when the completion carries none", () => {
    let state = reducer(initialState, { type: "thread/opened", thread: info, settings: { effort: "medium", sandbox: "workspace-write", approval: "on-request", network: false }, turns: [] });
    expect(state.currentId).toBe("th");
    state = notify(state, { method: "turn/started", params: { threadId: "th", turn: turn([user], "running") } });
    expect(state.threads.th?.info.running).toBe(true);
    state = notify(state, { method: "item/started", params: { threadId: "th", turnId: "t1", item: message("a", "", null, "running") } });
    state = notify(state, { method: "item/delta", params: { threadId: "th", turnId: "t1", itemId: "a", kind: "text", delta: "Hel" } });
    state = notify(state, { method: "item/delta", params: { threadId: "th", turnId: "t1", itemId: "a", kind: "text", delta: "lo" } });
    expect(state.threads.th?.turns[0]?.items[1]).toMatchObject({ text: "Hello" });
    state = notify(state, { method: "item/completed", params: { threadId: "th", turnId: "t1", item: message("a", "Hello", "final_answer") } });
    state = notify(state, { method: "turn/completed", params: { threadId: "th", turn: { ...turn([], "completed") } } });
    const thread = state.threads.th;
    expect(thread?.info.running).toBe(false);
    expect(thread?.turns[0]?.status).toBe("completed");
    expect(thread?.turns[0]?.items.map((item) => item.id)).toEqual(["u", "a"]);
  });

  it("keeps a known title, tracks approvals and sorts threads by recency", () => {
    let state = reducer(initialState, { type: "threads/listed", threads: [{ ...info, title: "First" }, { ...info, id: "older", updatedAt: 0 }] });
    state = notify(state, { method: "thread/updated", params: { thread: { ...info, title: "", updatedAt: 5 } } });
    expect(state.threads.th?.info.title).toBe("First");
    expect(sortedThreads(state).map((thread) => thread.info.id)).toEqual(["th", "older"]);
    const request: ServerRequest = {
      id: 7,
      method: "approval/request",
      params: { threadId: "th", turnId: "t1", itemId: "x3", request: { kind: "command", command: "npm i", cwd: "/w", reason: "escalation", sandboxed: false, rememberPrefixes: null } },
    };
    state = reducer(state, { type: "approval/requested", request });
    expect(state.approvals).toHaveLength(1);
    expect(reducer(state, { type: "approval/answered", id: 7 }).approvals).toHaveLength(0);
  });
});

describe("projects and chats in the sidebar (F4.5)", () => {
  const project = (id: string, createdAt: string): ProjectInfo => ({ id, name: id, main: `/p/${id}`, references: [], createdAt });
  const chat = (id: string, projectId: string | null, updatedAt: number): ThreadInfo => ({ id, title: id, cwd: "/w", projectId, scratch: projectId === null, model: "m", createdAt: "2026-10-01T00:00:00.000Z", updatedAt, loaded: false, running: false });
  const settings = { effort: "medium", sandbox: "workspace-write", approval: "on-request", network: false } as const;

  const start = () => {
    let state = reducer(initialState, { type: "projects/listed", projects: [project("old", "2026-01-01T00:00:00.000Z"), project("busy", "2026-02-01T00:00:00.000Z"), project("fresh", "2026-09-30T00:00:00.000Z")] });
    state = reducer(state, { type: "threads/listed", threads: [chat("a", "busy", Date.parse("2026-10-01T10:00:00Z")), chat("b", "busy", Date.parse("2026-10-01T09:00:00Z")), chat("c", null, 5), chat("d", "gone", 6)] });
    return state;
  };

  it("groups chats under their projects, recent activity first, and keeps the rest as chats", () => {
    const groups = sidebarGroups(start());
    expect(groups.projects.map(({ project, chats }) => [project.id, chats.map((thread) => thread.info.id)])).toEqual([
      ["busy", ["a", "b"]],
      ["fresh", []],
      ["old", []],
    ]);
    // A chat whose project no longer exists shows with the chats without a project.
    expect(groups.chats.map((thread) => thread.info.id)).toEqual(["d", "c"]);
  });

  it("moves a removed project's chats to the chats without a project", () => {
    let state = reducer(start(), { type: "draft/open", projectId: "busy" });
    state = reducer(state, { type: "project/removed", id: "busy" });
    expect(state.projects.map((entry) => entry.id)).toEqual(["old", "fresh"]);
    expect(sidebarGroups(state).chats.map((thread) => thread.info.id)).toEqual(["a", "b", "d", "c"]);
    expect(state.draft).toEqual({ projectId: null });
  });

  it("opens a draft, leaves it for a chat, and returns to a draft in the same project when that chat is deleted", () => {
    let state = reducer(start(), { type: "draft/open", projectId: "busy" });
    expect(state).toMatchObject({ currentId: null, draft: { projectId: "busy" } });
    state = reducer(state, { type: "thread/opened", thread: { ...chat("a", "busy", 1), loaded: true }, settings, turns: [] });
    expect(state).toMatchObject({ currentId: "a", draft: null });
    const request: ServerRequest = { id: 1, method: "approval/request", params: { threadId: "a", turnId: "t", itemId: "i", request: { kind: "command", command: "x", cwd: "/w", reason: "untrusted", sandboxed: true, rememberPrefixes: null } } };
    state = reducer(state, { type: "approval/requested", request });
    state = reducer(state, { type: "thread/deleted", id: "a" });
    expect(state.threads.a).toBeUndefined();
    expect(state.approvals).toEqual([]);
    expect(state).toMatchObject({ currentId: null, draft: { projectId: "busy" } });
  });

  it("formats a chat's age compactly", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    expect([0.5, 5, 3 * 60, 2 * 1440, 3 * 7 * 1440, 70 * 1440, 400 * 1440].map((minutes) => formatAge(now - minutes * 60_000, now, "en"))).toEqual(["now", "5m", "3h", "2d", "3w", "2mo", "1y"]);
    expect(formatAge(now - 5 * 60_000, now, "zh-CN")).toBe("5 分钟");
  });
});

describe("composer send key", () => {
  const key = (overrides: Partial<Parameters<typeof isSendKey>[0]>) => isSendKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...overrides });
  it("sends on Enter only", () => {
    expect(key({})).toBe(true);
    expect(key({ shiftKey: true })).toBe(false);
    expect(key({ key: "a" })).toBe(false);
  });
  it("never sends while an input method is composing", () => {
    expect(key({ isComposing: true })).toBe(false);
    expect(key({ keyCode: 229 })).toBe(false);
  });
});

describe("dictionaries", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  it("have the same placeholders in every language", () => {
    for (const [key, english] of Object.entries(DICTIONARIES.en)) {
      expect(placeholders(DICTIONARIES["zh-CN"][key as MessageKey]), key).toEqual(placeholders(english));
    }
  });

  it("cover every key the UI builds dynamically", () => {
    const rowKinds: RowKind[] = ["read", "search", "searchIn", "list", "listIn", "run", "add", "update", "delete", "move", "stdin", "poll", "image", "tool"];
    const parts: SummaryPart[] = ["read", "readOne", "search", "list", "run", "runOne", "edit", "editOne", "stdin", "image", "other"];
    const dynamic = [
      ...rowKinds.map((kind) => `row.${kind}`),
      ...parts.map((part) => `activity.${part}`),
      ...["none", "low", "medium", "high"].map((effort) => `effort.${effort}`),
      ...["read-only", "workspace-write", "danger-full-access"].map((mode) => `sandbox.${mode}`),
      ...["untrusted", "on-request", "never"].map((policy) => `approval.policy.${policy}`),
      ...["system", "light", "dark"].map((appearance) => `appearance.${appearance}`),
    ];
    for (const key of dynamic) expect(DICTIONARIES.en, key).toHaveProperty([key]);
  });

  it("fill values and format durations per language", () => {
    expect(translator("en")("workedFor", { duration: formatDuration(479_000, "en") })).toBe("Worked for 7m 59s");
    expect(formatDuration(479_000, "zh-CN")).toBe("7 分 59 秒");
    expect(formatDuration(3_780_000, "en")).toBe("1h 3m");
  });
});
