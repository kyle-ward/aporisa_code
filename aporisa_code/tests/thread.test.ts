import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initialContext,
  normalizeHistory,
  SessionStore,
  Thread,
  type ThreadEvent,
  type ThreadOptions,
} from "../src/harness/index.ts";
import { NodeHost } from "../src/host/index.ts";
import { mockModel, StubDriver, type MockPlan, type MockStep } from "../src/mock/index.ts";
import type { InputItem, Model, ResponseParams } from "../src/protocol/index.ts";

let root: string;
let workspace: string;
let dataDir: string;
let host: NodeHost;
const threads: Thread[] = [];

/** A stub whose generating requests follow `plans` in order, then answer "done". */
function stub(plans: (MockPlan | MockStep[])[], model?: Model): StubDriver {
  const queue = [...plans];
  return new StubDriver({
    ...(model ? { model } : {}),
    script: () => {
      const next = queue.shift();
      if (!next) return { steps: [{ type: "message", text: "done", phase: "final_answer" }] };
      return Array.isArray(next) ? { steps: next } : next;
    },
  });
}

function call(name: string, args: unknown): MockStep {
  return { type: "function_call", name, arguments: JSON.stringify(args) };
}

async function start(client: StubDriver, options: Partial<ThreadOptions> = {}): Promise<{ thread: Thread; events: ThreadEvent[] }> {
  const events: ThreadEvent[] = [];
  const thread = await Thread.start({ client, host, cwd: workspace, persist: false, listener: (event) => events.push(event), ...options });
  threads.push(thread);
  return { thread, events };
}

/** Generating requests only (the prewarm is a generate:false request). */
function generating(client: StubDriver): ResponseParams[] {
  return client.requests.filter((request) => request.generate !== false);
}

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aporisa-thread-"));
  workspace = join(root, "work");
  dataDir = join(root, "data");
  await mkdir(workspace);
  host = new NodeHost({ shell: "/bin/sh", dataDir });
});

afterEach(async () => {
  await Promise.all(threads.splice(0).map((thread) => thread.close()));
  await rm(root, { recursive: true, force: true });
});

describe("turn loop", () => {
  it("runs a multi-step task to the expected files and keeps the request prefix stable", async () => {
    await writeFile(join(workspace, "a.txt"), "hello\n");
    const client = stub([
      [{ type: "reasoning", text: "look first" }, call("exec_command", { cmd: "cat a.txt" })],
      [call("apply_patch", { input: patch("*** Update File: a.txt\n@@\n-hello\n+hello world") })],
      [{ type: "message", text: "checking", phase: "commentary" }, call("exec_command", { cmd: "grep -q 'hello world' a.txt && echo ok" })],
      [{ type: "message", text: "All done.", phase: "final_answer" }],
    ]);
    const { thread, events } = await start(client);
    const outcome = await thread.runTurn("fix a.txt");

    expect(outcome).toMatchObject({ status: "completed", requests: 4, lastMessage: "All done." });
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("hello world\n");
    expect(client.requests[0]?.generate).toBe(false); // prewarm of the fixed context
    const requests = generating(client);
    expect(requests).toHaveLength(4);
    for (const [index, request] of requests.entries()) {
      expect(request.instructions).toBe(requests[0]?.instructions);
      expect(request.tools).toEqual(requests[0]?.tools);
      expect(request.prompt_cache_key).toBe(thread.id);
      expect(request.reasoning).toEqual({ effort: "medium" });
      const next = requests[index + 1];
      if (next) expect(next.input.slice(0, request.input.length)).toEqual(request.input);
    }
    const outputs = thread.items.filter((item) => item.type === "function_call_output");
    expect(outputs.map((item) => item.type === "function_call_output" && item.output)).toEqual([
      expect.stringContaining("Output:\nhello\n"),
      "Success. Updated the following files:\nM a.txt",
      expect.stringContaining("Output:\nok\n"),
    ]);
    expect(outcome.usage.cachedTokens).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).toContain("tool.completed");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", outcome: { status: "completed" } });
  });

  it("runs parallel calls concurrently and writes results back in call order", async () => {
    const client = stub([[call("exec_command", { cmd: "sleep 0.3; echo first" }), call("exec_command", { cmd: "echo second" })]]);
    const { thread, events } = await start(client);
    await thread.runTurn("go");
    const completed = events.filter((event) => event.type === "tool.completed").map((event) => event.type === "tool.completed" && event.output);
    expect(completed[0]).toContain("second");
    const kinds = thread.items.slice(-5).map((item) => (item.type === "function_call_output" ? `out:${String(item.output).trim().split("\n").at(-1)}` : item.type));
    expect(kinds).toEqual(["function_call", "function_call", "out:first", "out:second", "message"]);
  });

  // Unknown tool names are covered in tools.test.ts: the mock refuses to emit undeclared tools.
  it("lets the model recover from bad arguments", async () => {
    const client = stub([[call("exec_command", { command: "ls" })], [call("update_plan", { plan: [{ step: "a", status: "done" }] })]]);
    const { thread } = await start(client);
    const outcome = await thread.runTurn("go");
    expect(outcome).toMatchObject({ status: "completed", requests: 3 });
    const outputs = thread.items.filter((item) => item.type === "function_call_output").map((item) => item.type === "function_call_output" && item.output);
    expect(outputs[0]).toContain("missing 'cmd'");
    expect(outputs[1]).toContain("not one of the enum values");
  });

  it("requests again once after a malformed tool call, then gives up (FD-08)", async () => {
    const broken: MockPlan = { steps: [], failAfter: { steps: 0, code: "tool_call_invalid", message: "The tool call was not closed." } };
    const once = await start(stub([broken]));
    const recovered = await once.thread.runTurn("go");
    expect(recovered).toMatchObject({ status: "completed", requests: 2, lastMessage: "done" });
    expect(once.events.some((event) => event.type === "warning")).toBe(true);

    const twice = await start(stub([broken, broken]));
    const failed = await twice.thread.runTurn("go");
    expect(failed).toMatchObject({ status: "failed", requests: 2, error: { code: "tool_call_invalid" } });
  });

  it("resends the identical request when nothing ran before the malformed call (FD-08)", async () => {
    const broken: MockPlan = {
      steps: [{ type: "reasoning", text: "thinking" }, { type: "message", text: "renaming now", phase: "commentary" }, call("exec_command", { cmd: "true" })],
      failAfter: { steps: 2, code: "tool_call_invalid", message: "The tool call was not closed." },
    };
    const client = stub([broken]);
    const { thread } = await start(client);
    expect(await thread.runTurn("go")).toMatchObject({ status: "completed", requests: 2 });
    const [failed, retried] = generating(client);
    expect(retried?.input).toEqual(failed?.input);
    expect(thread.items.some((item) => item.type === "message" && item.content.some((part) => part.type === "output_text" && part.text === "renaming now"))).toBe(false);
  });

  it("keeps executed calls and their outputs when the response fails afterwards (FD-08)", async () => {
    const broken: MockPlan = {
      steps: [call("exec_command", { cmd: "echo ran" }), call("exec_command", { cmd: "true" })],
      failAfter: { steps: 1, code: "tool_call_invalid", message: "The tool call was not closed." },
    };
    const client = stub([broken]);
    const { thread } = await start(client);
    expect(await thread.runTurn("go")).toMatchObject({ status: "completed", requests: 2 });
    const [failed, retried] = generating(client);
    expect(retried?.input.slice(0, failed?.input.length)).toEqual(failed?.input);
    expect(retried?.input.slice(failed?.input.length ?? 0).map((item) => item.type)).toEqual(["function_call", "function_call_output"]);
  });

  it("stops at the request limit with a valid history", async () => {
    const client = stub(Array.from({ length: 3 }, () => [call("exec_command", { cmd: "true" })]));
    const { thread } = await start(client, { maxRequestsPerTurn: 3 });
    expect(await thread.runTurn("loop")).toMatchObject({ status: "failed", requests: 3, error: { code: "max_requests" } });
    expect(await thread.runTurn("next")).toMatchObject({ status: "completed" }); // the stub validates call/output pairing
  });

  it("refuses to send a request beyond the context window", async () => {
    const client = stub([], mockModel({ context_window: 3_000, max_output_tokens: 1_000 }));
    const { thread } = await start(client, { prewarm: false });
    expect(await thread.runTurn("x".repeat(20_000))).toMatchObject({ status: "failed", requests: 0, error: { code: "context_window_exceeded" } });
    expect(client.requests).toHaveLength(0);
  });
});

describe("cancellation", () => {
  it("interrupts a running command, kills it and leaves a sendable history", async () => {
    const client = stub([[call("exec_command", { cmd: "echo $$ > pid.txt; sleep 30", yield_time_ms: 30_000 })]]);
    const controller = new AbortController();
    const { thread } = await start(client, {
      listener: (event) => {
        if (event.type === "tool.started") setTimeout(() => controller.abort(), 300);
      },
    });
    const outcome = await thread.runTurn("go", { signal: controller.signal });
    expect(outcome.status).toBe("interrupted");
    const last = thread.items.at(-1);
    expect(last).toMatchObject({ type: "function_call_output", output: "The command was interrupted by the user before it finished." });
    const pid = Number((await readFile(join(workspace, "pid.txt"), "utf8")).trim());
    expect(alive(pid)).toBe(false);
    expect(await thread.runTurn("continue")).toMatchObject({ status: "completed" });
  });

  it("interrupts streaming text and drops the half-written message", async () => {
    const client = stub([[{ type: "message", text: "a long answer ".repeat(50), phase: "final_answer" }]]);
    client.engine.chunkSize = 2;
    client.engine.chunkDelayMs = 2;
    const controller = new AbortController();
    const { thread } = await start(client, {
      listener: (event) => {
        if (event.type === "item.delta") controller.abort();
      },
    });
    expect(await thread.runTurn("talk", { signal: controller.signal })).toMatchObject({ status: "interrupted" });
    expect(thread.items.at(-1)).toMatchObject({ type: "message", role: "user" });
  });
});

describe("approvals and effort", () => {
  it("asks before commands under the untrusted policy and reports a refusal to the model", async () => {
    const client = stub([[call("exec_command", { cmd: "touch made" })]]);
    const { thread, events } = await start(client, { safety: { approval: "untrusted" }, approve: async () => "denied" });
    await thread.runTurn("go");
    expect(events.filter((event) => event.type.startsWith("approval."))).toMatchObject([
      { type: "approval.requested", request: { kind: "command", command: "touch made", reason: "untrusted" } },
      { type: "approval.resolved", approved: false, decision: "denied" },
    ]);
    expect(thread.items.find((item) => item.type === "function_call_output")).toMatchObject({ output: expect.stringContaining("declined") });
  });

  it("switches effort with configuration_update and keeps the request field", async () => {
    const client = stub([]);
    const { thread } = await start(client);
    await thread.runTurn("one");
    thread.setEffort("high");
    await thread.runTurn("two");
    const last = generating(client).at(-1);
    expect(last?.reasoning).toEqual({ effort: "medium" });
    expect(last?.input.slice(-2)).toMatchObject([{ type: "configuration_update", reasoning: { effort: "high" } }, { type: "message", role: "user" }]);
    expect(thread.effort).toBe("high");
  });

  it("changes the baseline when the model cannot take configuration_update", async () => {
    const model = mockModel({ capabilities: { ...mockModel().capabilities, reasoning_effort_updates: false } });
    const client = stub([], model);
    const { thread } = await start(client);
    await thread.runTurn("one");
    thread.setEffort("low");
    await thread.runTurn("two");
    expect(generating(client).at(-1)?.reasoning).toEqual({ effort: "low" });
    expect(thread.items.some((item) => item.type === "configuration_update")).toBe(false);
  });
});

describe("session record", () => {
  it("keeps the full tool output on disk and history truncated, privately", async () => {
    const model = mockModel({ truncation_policy: { mode: "bytes", limit: 300 } });
    const client = stub([[call("exec_command", { cmd: "printf '%01000d' 0" })]], model);
    const { thread } = await start(client, { persist: true });
    await thread.runTurn("go");
    await thread.close();
    const output = thread.items.find((item) => item.type === "function_call_output");
    expect(new TextEncoder().encode(String(output?.type === "function_call_output" && output.output)).byteLength).toBeLessThanOrEqual(360);
    const path = thread.sessionPath ?? "";
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(path.startsWith(join(dataDir, "profiles", "local", "sessions"))).toBe(true);
    for (const directory of [dataDir, join(dataDir, "profiles"), join(dataDir, "profiles", "local", "sessions")]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "session_meta", payload: { id: thread.id, model: model.id, driver: "stub", effort: "medium" } });
    expect(lines.find((line) => line.payload?.fullOutput)?.payload.fullOutput).toBe("0".repeat(1000));
    expect(lines.filter((line) => line.type === "usage")).toHaveLength(2);
  });

  it("resumes with the identical history, so the next request extends it", async () => {
    const first = await start(stub([[call("exec_command", { cmd: "echo hi" })]]), { persist: true });
    await first.thread.runTurn("one");
    await first.thread.close();
    const before = [...first.thread.items];

    const client = stub([]);
    const resumed = await Thread.resume({ client, host, session: first.thread.id });
    threads.push(resumed);
    expect(resumed.items).toEqual(before);
    await resumed.runTurn("two");
    expect(client.requests[0]).toMatchObject({ generate: false, prompt_cache_key: first.thread.id });
    expect(generating(client)[0]?.input.slice(0, before.length)).toEqual(before);
    const loaded = await SessionStore.load(host.fs, first.thread.sessionPath ?? "");
    expect(loaded.items).toEqual(resumed.items);
  });
});

describe("initial context and history invariants", () => {
  it("adds the environment and the AGENTS.md files from the project root down", async () => {
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, "pkg"));
    await writeFile(join(workspace, "AGENTS.md"), "root rules\n");
    await writeFile(join(workspace, "pkg", "AGENTS.md"), "package rules\n");
    const cwd = join(await host.fs.realpath(workspace), "pkg");
    const items = await initialContext(cwd, host.fs, { ...host.info(), timeZone: "Asia/Hong_Kong" }, new Date("2026-10-01T20:00:00Z"));
    const texts = items.map((item) => (item.type === "message" && item.content[0]?.type === "input_text" ? item.content[0].text : ""));
    expect(texts[0]).toBe(`<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>sh</shell>\n  <current_date>2026-10-02</current_date>\n  <timezone>Asia/Hong_Kong</timezone>\n</environment_context>`);
    expect(texts[1]).toBe(`# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nroot rules\n\npackage rules\n</INSTRUCTIONS>`);
  });

  it("answers dangling calls and drops orphan outputs", () => {
    const items: InputItem[] = [
      { type: "function_call_output", call_id: "orphan", output: "x" },
      { type: "function_call", call_id: "a", name: "exec_command", arguments: "{}" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ];
    expect(normalizeHistory(items)).toEqual([items[1], { type: "function_call_output", call_id: "a", output: "aborted" }, items[2]]);
    const clean = [items[2] as InputItem];
    expect(normalizeHistory(clean)).toBe(clean);
  });
});
