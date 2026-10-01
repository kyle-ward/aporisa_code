// F3 through the turn loop: real Seatbelt, scripted model, scripted approvals.
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Thread, type ApprovalDecision, type ApprovalRequest, type ThreadEvent, type ThreadOptions } from "../src/harness/index.ts";
import { NodeHost } from "../src/host/index.ts";
import { StubDriver, type MockPlan, type MockStep } from "../src/mock/index.ts";
import type { FunctionTool, InputItem, ResponseParams } from "../src/protocol/index.ts";

let root: string;
let workspace: string;
let outside: string;
let host: NodeHost;
const threads: Thread[] = [];

function stub(plans: (MockPlan | MockStep[])[]): StubDriver {
  const queue = [...plans];
  return new StubDriver({
    script: () => {
      const next = queue.shift();
      if (!next) return { steps: [{ type: "message", text: "done", phase: "final_answer" }] };
      return Array.isArray(next) ? { steps: next } : next;
    },
  });
}

const call = (name: string, args: unknown): MockStep => ({ type: "function_call", name, arguments: JSON.stringify(args) });
const generating = (client: StubDriver): ResponseParams[] => client.requests.filter((request) => request.generate !== false);

async function start(client: StubDriver, options: Partial<ThreadOptions> = {}) {
  const events: ThreadEvent[] = [];
  const asked: ApprovalRequest[] = [];
  const answers = [...((options as { answers?: ApprovalDecision[] }).answers ?? [])];
  const thread = await Thread.start({
    client,
    host,
    cwd: workspace,
    persist: false,
    safety: { tmpWritable: false },
    listener: (event) => events.push(event),
    approve: async (request) => {
      asked.push(request);
      return answers.shift() ?? "denied";
    },
    ...options,
  });
  threads.push(thread);
  return { thread, events, asked };
}

function outputs(thread: Thread): string[] {
  return thread.items.flatMap((item) => (item.type === "function_call_output" ? [String(item.output)] : []));
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "aporisa-f3-")));
  workspace = join(root, "work");
  outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  host = new NodeHost({ shell: "/bin/sh", dataDir: join(root, "data") });
});

afterEach(async () => {
  await Promise.all(threads.splice(0).map((thread) => thread.close()));
  await rm(root, { recursive: true, force: true });
});

describe("permissions in the request", () => {
  it("tells the model its permissions and offers escalation only when it can be approved", async () => {
    const onRequest = stub([]);
    const { thread } = await start(onRequest);
    await thread.runTurn("hi");
    const permissions = thread.items[1];
    expect(permissions).toMatchObject({ type: "message", role: "developer" });
    expect(JSON.stringify(permissions)).toContain("<permissions>");
    const exec = (client: StubDriver) => generating(client)[0]?.tools?.find((tool) => tool.name === "exec_command") as FunctionTool;
    expect(Object.keys(exec(onRequest).parameters.properties as object)).toContain("sandbox_permissions");

    const never = stub([]);
    const off = await start(never, { safety: { approval: "never" } });
    await off.thread.runTurn("hi");
    expect(Object.keys(exec(never).parameters.properties as object)).not.toContain("sandbox_permissions");
  });
});

describe("commands", () => {
  it("runs in the sandbox and points the model at escalation after a denial", async () => {
    const client = stub([[call("exec_command", { cmd: `echo x > '${outside}/a.txt'` })]]);
    const { thread, asked, events } = await start(client);
    await thread.runTurn("go");
    expect(asked).toEqual([]);
    expect(await exists(join(outside, "a.txt"))).toBe(false);
    expect(outputs(thread)[0]?.toLowerCase()).toContain("operation not permitted");
    expect(outputs(thread)[0]).toContain('"sandbox_permissions": "require_escalated"');
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({ details: { sandboxed: true, escalated: false } });
  });

  it("runs an approved escalation outside the sandbox and remembers it for the session", async () => {
    const escalate = (file: string) => call("exec_command", { cmd: `touch '${outside}/${file}'`, sandbox_permissions: "require_escalated", justification: "May I write next to the workspace?" });
    const client = stub([[escalate("a")], [escalate("b")]]);
    const { thread, asked, events } = await start(client, { answers: ["approved_for_session"] } as Partial<ThreadOptions>);
    await thread.runTurn("go");
    expect(asked).toEqual([
      { kind: "command", command: `touch '${outside}/a'`, cwd: workspace, reason: "escalation", sandboxed: false, justification: "May I write next to the workspace?", rememberPrefixes: [["touch"]] },
    ]);
    expect(await exists(join(outside, "a"))).toBe(true);
    expect(await exists(join(outside, "b"))).toBe(true);
    expect(events.filter((event) => event.type === "tool.completed").map((event) => event.type === "tool.completed" && event.details)).toMatchObject([
      { sandboxed: false, escalated: true },
      { sandboxed: false, escalated: true },
    ]);
  });

  it("refuses escalation that nobody can approve, and with approvals off the parameter does not exist", async () => {
    const request = call("exec_command", { cmd: `touch '${outside}/a'`, sandbox_permissions: "require_escalated" });
    const noApprover = await Thread.start({ client: stub([[request]]), host, cwd: workspace, persist: false, safety: { tmpWritable: false } });
    threads.push(noApprover);
    await noApprover.runTurn("go");
    expect(outputs(noApprover)[0]).toContain("nobody can be asked");

    const off = await start(stub([[request]]), { safety: { approval: "never", tmpWritable: false } });
    await off.thread.runTurn("go");
    expect(outputs(off.thread)[0]).toContain("Invalid arguments for exec_command");
    expect(await exists(join(outside, "a"))).toBe(false);
  });

  it("asks again outside the sandbox after a denial under the untrusted policy", async () => {
    const client = stub([[call("exec_command", { cmd: `echo x > '${outside}/c.txt'` })]]);
    const { thread, asked } = await start(client, { safety: { approval: "untrusted", tmpWritable: false }, answers: ["approved", "approved"] } as Partial<ThreadOptions>);
    await thread.runTurn("go");
    expect(asked.map((request) => request.kind === "command" && [request.reason, request.sandboxed])).toEqual([
      ["untrusted", true],
      ["sandbox_denied", false],
    ]);
    expect(await readFile(join(outside, "c.txt"), "utf8")).toBe("x\n");
  });
});

describe("patches and images", () => {
  it("asks before writing outside the workspace or into .git", async () => {
    await mkdir(join(workspace, ".git"));
    const client = stub([
      [call("apply_patch", { input: `*** Begin Patch\n*** Add File: ${outside}/new.txt\n+hello\n*** End Patch` })],
      [call("apply_patch", { input: "*** Begin Patch\n*** Add File: .git/hooks/pre-commit\n+exit 0\n*** End Patch" })],
      [call("apply_patch", { input: "*** Begin Patch\n*** Add File: inside.txt\n+ok\n*** End Patch" })],
    ]);
    const { thread, asked } = await start(client, { answers: ["approved", "denied"] } as Partial<ThreadOptions>);
    await thread.runTurn("go");
    expect(asked).toMatchObject([
      { kind: "patch", reason: "outside_workspace", paths: [join(outside, "new.txt")] },
      { kind: "patch", reason: "outside_workspace", paths: [join(workspace, ".git", "hooks", "pre-commit")] },
    ]);
    expect(await readFile(join(outside, "new.txt"), "utf8")).toBe("hello\n");
    expect(await exists(join(workspace, ".git", "hooks"))).toBe(false);
    expect(await readFile(join(workspace, "inside.txt"), "utf8")).toBe("ok\n");
  });

  it("does not read images from private locations", async () => {
    const secret = join(root, "secret");
    await mkdir(secret);
    await writeFile(join(secret, "x.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const client = stub([[call("view_image", { path: join(secret, "x.png") })]]);
    const { thread } = await start(client, { safety: { tmpWritable: false, denyRead: [secret] } });
    await thread.runTurn("go");
    expect(outputs(thread)[0]).toContain("private location");
  });
});

describe("resume", () => {
  it("tells the model when the settings changed, at the end of the history", async () => {
    const first = await start(stub([]), { persist: true });
    await first.thread.runTurn("one");
    await first.thread.close();
    const client = stub([]);
    const resumed = await Thread.resume({ client, host, session: first.thread.id, safety: { approval: "never", tmpWritable: false } });
    threads.push(resumed);
    await resumed.runTurn("two");
    const input = generating(client)[0]?.input ?? [];
    const tail = input.slice(-2) as InputItem[];
    expect(tail[0]).toMatchObject({ type: "message", role: "developer" });
    expect(JSON.stringify(tail[0])).toContain("Approvals are off");
    expect(tail[1]).toMatchObject({ type: "message", role: "user" });

    const same = await Thread.resume({ client: stub([]), host, session: first.thread.id, safety: { approval: "never", tmpWritable: false } });
    threads.push(same);
    expect(same.items.filter((item) => item.type === "message" && item.role === "developer")).toHaveLength(2);
  });
});
