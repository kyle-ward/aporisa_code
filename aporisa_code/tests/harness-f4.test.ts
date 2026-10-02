// F4 harness additions: activity classification, compaction, mid-thread settings,
// session listing and the richer session record.
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autoCompactThreshold,
  classifyCommand,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  defaultSessionsDir,
  SessionStore,
  Thread,
  type ThreadEvent,
  type ThreadOptions,
} from "../src/harness/index.ts";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../src/harness/instructions.ts";
import { NodeHost } from "../src/host/index.ts";
import { lastUserText, mockModel, StubDriver, type MockPlan, type MockStep } from "../src/mock/index.ts";
import type { FunctionTool, InputItem, Model, ResponseParams } from "../src/protocol/index.ts";

let root: string;
let workspace: string;
let dataDir: string;
let host: NodeHost;
const threads: Thread[] = [];

const call = (name: string, args: unknown): MockStep => ({ type: "function_call", name, arguments: JSON.stringify(args) });

/** Scripted plans; compaction requests (ending with the codex prompt) get a summary. */
function stub(plans: (MockPlan | MockStep[])[], model?: Model): StubDriver {
  const queue = [...plans];
  return new StubDriver({
    ...(model ? { model } : {}),
    script: ({ params }) => {
      if (lastUserText(params.input) === COMPACT_PROMPT) return { steps: [{ type: "message", text: "SUMMARY: fixed a.txt", phase: "final_answer" }] };
      const next = queue.shift();
      if (!next) return { steps: [{ type: "message", text: "done", phase: "final_answer" }] };
      return Array.isArray(next) ? { steps: next } : next;
    },
  });
}

const generating = (client: StubDriver): ResponseParams[] => client.requests.filter((request) => request.generate !== false);

async function start(client: StubDriver, options: Partial<ThreadOptions> = {}) {
  const events: ThreadEvent[] = [];
  const thread = await Thread.start({ client, host, cwd: workspace, prewarm: false, listener: (event) => events.push(event), ...options });
  threads.push(thread);
  return { thread, events };
}

function text(item: InputItem | undefined): string {
  return item?.type === "message" ? item.content.map((part) => (part.type === "input_image" ? "" : part.text)).join("") : "";
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "aporisa-f4-")));
  workspace = join(root, "work");
  dataDir = join(root, "data");
  await mkdir(workspace);
  host = new NodeHost({ shell: "/bin/sh", dataDir });
});

afterEach(async () => {
  await Promise.all(threads.splice(0).map((thread) => thread.close()));
  await rm(root, { recursive: true, force: true });
});

describe("activity classification", () => {
  it("recognizes reads, searches and listings, also behind cd and before filters", () => {
    expect(classifyCommand("cat src/a.ts")).toEqual([{ kind: "read", path: "src/a.ts" }]);
    expect(classifyCommand("cd /w && sed -n '1,120p' app.py")).toEqual([{ kind: "read", path: "app.py" }]);
    expect(classifyCommand("head -n 20 a.txt b.txt")).toEqual([{ kind: "read", path: "a.txt" }, { kind: "read", path: "b.txt" }]);
    expect(classifyCommand("cat log.txt | tail -5")).toEqual([{ kind: "read", path: "log.txt" }]);
    expect(classifyCommand('rg -n "calc_area" src')).toEqual([{ kind: "search", query: "calc_area", path: "src" }]);
    expect(classifyCommand("grep -rn -e foo .")).toEqual([{ kind: "search", query: "foo", path: "." }]);
    expect(classifyCommand("rg --files src")).toEqual([{ kind: "list", path: "src" }]);
    expect(classifyCommand("find . -name '*.py'")).toEqual([{ kind: "search", query: "*.py", path: "." }]);
    expect(classifyCommand("ls -la")).toEqual([{ kind: "list", path: null }]);
    expect(classifyCommand('echo "== a" ; cat a ; echo "== b" ; cat b')).toEqual([{ kind: "read", path: "a" }, { kind: "read", path: "b" }]);
  });

  it("falls back to a single run for anything else", () => {
    for (const command of ["python3 -m unittest", "cat a > b", "ls && npm test", "sed -i '' s/a/b/ f", "cat", "find . -delete", "echo $HOME"]) {
      expect(classifyCommand(command), command).toEqual([{ kind: "run", command }]);
    }
  });
});

describe("context compaction (F4 baseline)", () => {
  it("uses codex's threshold rule and the request limit", () => {
    const model = mockModel({ context_window: 262_144, max_output_tokens: 32_768, auto_compact_token_limit: null });
    expect(autoCompactThreshold(model, undefined)).toBe(Math.floor((Math.floor(262_144 * 0.95) - 32_768) * 0.9));
    expect(autoCompactThreshold(mockModel({ auto_compact_token_limit: 1_000 }), undefined)).toBe(1_000);
    expect(COMPACT_USER_MESSAGE_MAX_TOKENS).toBe(20_000);
  });

  it("compacts automatically before a request and continues the turn", async () => {
    const client = stub([[call("exec_command", { cmd: "printf '%02000d' 0" })]], mockModel({ auto_compact_token_limit: 2_600 }));
    const { thread, events } = await start(client, { persist: true });
    const opening = thread.items.length;
    const outcome = await thread.runTurn("fix a.txt");
    expect(outcome).toMatchObject({ status: "completed", lastMessage: "done" });
    expect(events.filter((event) => event.type === "compaction.completed")).toMatchObject([{ reason: "auto", compacted: true }]);
    const requests = generating(client);
    const compaction = requests.find((request) => lastUserText(request.input) === COMPACT_PROMPT);
    expect(compaction).toMatchObject({ tool_choice: "none" });
    const last = requests.at(-1)?.input ?? [];
    expect(last).toHaveLength(opening + 2);
    expect(text(last[opening])).toBe("fix a.txt");
    expect(text(last[opening + 1])).toBe(`${SUMMARY_PREFIX}\nSUMMARY: fixed a.txt`);

    await thread.close();
    const resumed = await Thread.resume({ client: stub([]), host, session: thread.id, prewarm: false });
    threads.push(resumed);
    expect(resumed.items).toEqual(thread.items);
  });

  it("compacts on request between turns and keeps recent user messages", async () => {
    const client = stub([]);
    const { thread, events } = await start(client);
    await thread.runTurn("first");
    await thread.runTurn("second");
    const result = await thread.compact();
    expect(result.compacted).toBe(true);
    expect(events.find((event) => event.type === "compaction.completed")).toMatchObject({ reason: "manual", turnId: null });
    expect(thread.items.slice(-3).map(text)).toEqual(["first", "second", `${SUMMARY_PREFIX}\nSUMMARY: fixed a.txt`]);
    await thread.compact();
    expect(thread.items.filter((item) => text(item).startsWith(SUMMARY_PREFIX))).toHaveLength(1);
  });
});

describe("mid-thread settings", () => {
  it("applies new safety settings at the next turn and tells the model", async () => {
    const client = stub([]);
    const { thread, events } = await start(client, { persist: true, safety: { tmpWritable: false } });
    await thread.runTurn("one");
    thread.setSafety({ approval: "never" });
    expect(thread.safety.approval).toBe("on-request");
    await thread.runTurn("two");
    expect(thread.safety.approval).toBe("never");
    expect(events.find((event) => event.type === "safety.changed")).toMatchObject({ safety: { approval: "never" } });
    const last = generating(client).at(-1);
    const exec = last?.tools?.find((tool) => tool.name === "exec_command") as FunctionTool;
    expect(Object.keys(exec.parameters.properties as object)).not.toContain("sandbox_permissions");
    expect(last?.input.slice(-2).map((item) => item.type === "message" && item.role)).toEqual(["developer", "user"]);
    await thread.close();
    const resumed = await Thread.resume({ client: stub([]), host, session: thread.id, prewarm: false, safety: { approval: "never", tmpWritable: false } });
    threads.push(resumed);
    expect(resumed.items).toEqual(thread.items);
    await resumed.runTurn("three");
    expect(resumed.items.filter((item) => item.type === "message" && item.role === "developer")).toHaveLength(2);
  });
});

describe("reference directories (F4.5)", () => {
  it("lists them read-only in the opening context, tells changes, and restates them after compaction", async () => {
    const refs = join(root, "refs");
    const more = join(root, "more");
    await mkdir(refs);
    await mkdir(more);
    const client = stub([]);
    const { thread, events } = await start(client, { persist: true, references: [refs, refs, workspace], projectId: "p1" });
    expect(thread.references).toEqual([refs]);
    expect(text(thread.items[0])).toContain(`<directory>${refs}</directory>`);
    expect(text(thread.items[0])).toContain("Do not modify them");
    await expect(start(stub([]), { references: [join(root, "missing")] })).rejects.toThrow("reference directory not found");

    thread.setReferences([refs, more]);
    thread.setSafety({ network: true });
    await thread.runTurn("one");
    expect(events.find((event) => event.type === "context.changed")).toMatchObject({ references: [refs, more] });
    // Unchanged references tell nothing.
    thread.setReferences([more, refs].reverse());
    await thread.runTurn("two");
    expect(events.filter((event) => event.type === "context.changed")).toHaveLength(1);

    await thread.compact();
    const opening = thread.items.slice(0, 2);
    const restated = thread.items.slice(2, 4);
    expect(text(opening[0])).not.toContain(more);
    expect(restated.map((item) => item.type === "message" && item.role)).toEqual(["developer", "user"]);
    expect(text(restated[0])).toContain("enabled");
    expect(text(restated[1])).toContain(`<directory>${more}</directory>`);
    expect(thread.items.slice(4).map(text)).toEqual(["one", "two", `${SUMMARY_PREFIX}\nSUMMARY: fixed a.txt`]);

    await thread.close();
    const loaded = await SessionStore.load(host.fs, thread.sessionPath as string);
    expect(loaded.meta).toMatchObject({ projectId: "p1", references: [refs] });
    expect(loaded.references).toEqual([refs, more]);
    // Resuming with other references tells the model at the next turn.
    const resumed = await Thread.resume({ client: stub([]), host, session: thread.id, prewarm: false, references: [] });
    threads.push(resumed);
    expect(resumed.references).toEqual([refs, more]);
    await resumed.runTurn("three");
    expect(resumed.references).toEqual([]);
    expect(text(resumed.items.at(-3))).toContain("<reference_directories>none</reference_directories>");
  });
});

describe("session record for the UI", () => {
  it("stores tool details and reasoning durations, and lists sessions newest first", async () => {
    const first = await start(stub([[{ type: "reasoning", text: "thinking" }, call("exec_command", { cmd: "cat a.txt" })]]), { persist: true });
    await first.thread.runTurn("look at a.txt");
    await first.thread.close();
    const lines = (await readFile(first.thread.sessionPath ?? "", "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.find((line) => line.type === "tool")).toMatchObject({ payload: { name: "exec_command", details: { kind: "command", actions: [{ kind: "read", path: "a.txt" }] } } });
    expect(lines.find((line) => line.type === "item" && line.payload.item.type === "reasoning")?.payload).toMatchObject({ durationMs: expect.any(Number), turnId: expect.any(String) });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await start(stub([]), { persist: true });
    await second.thread.runTurn("a second   thread\nwith two lines");
    await second.thread.close();
    const list = await SessionStore.list(host.fs, defaultSessionsDir(dataDir));
    expect(list.map((entry) => [entry.id, entry.title])).toEqual([
      [second.thread.id, "a second thread with two lines"],
      [first.thread.id, "look at a.txt"],
    ]);
    expect(list[0]).toMatchObject({ cwd: await realpath(workspace), model: "aporisa-mock-v0" });
  });
});
