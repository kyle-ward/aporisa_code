// The app's main-process server, headless: stub driver, real host in a temp dir, a fake
// keychain, notifications and approvals captured (DEVELOPMENT_PLAN.md 10.7).
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, Item, Notification, ParamsOf, Turn } from "../src/app-protocol/index.ts";
import { PARAMS } from "../src/app-protocol/index.ts";
import { NodeHost } from "../src/host/index.ts";
import { AppError, AppServer } from "../src/main/app-server.ts";
import { CredentialStore, type Encryptor } from "../src/main/credentials.ts";
import { ProjectStore } from "../src/main/projects.ts";
import { SettingsStore } from "../src/main/settings.ts";
import { isTrustedRendererUrl, rendererUrl } from "../src/main/renderer-url.ts";
import { parseEnvironment } from "../src/main/shell-env.ts";
import { lastUserText, StubDriver, type MockPlan, type MockStep } from "../src/mock/index.ts";
import { defaultSessionsDir, SessionStore, Thread } from "../src/harness/index.ts";
import { COMPACT_PROMPT } from "../src/harness/instructions.ts";

const fakeKeychain: Encryptor = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString("hex")}`),
  decrypt: (cipher) => Buffer.from(cipher.toString().slice(4), "hex").toString(),
};

const call = (name: string, args: unknown): MockStep => ({ type: "function_call", name, arguments: JSON.stringify(args) });

let root: string;
let workspace: string;
let dataDir: string;
let notifications: Notification[];
let plans: (MockPlan | MockStep[])[];
let answers: ApprovalDecision[];
let asked: unknown[];
let trashed: string[];
const servers: AppServer[] = [];

async function server(): Promise<AppServer> {
  const host = new NodeHost({ shell: "/bin/sh", dataDir });
  const settings = new SettingsStore(dataDir);
  await settings.load();
  const projects = new ProjectStore(dataDir);
  await projects.load();
  const app = new AppServer({
    projects,
    scratchDir: join(root, "scratch"),
    trash: async (path) => {
      // Like the Trash: the item leaves its place but still exists.
      const target = join(root, "trash", `${trashed.length}-${path.slice(path.lastIndexOf("/") + 1)}`);
      await mkdir(join(root, "trash"), { recursive: true });
      await rename(path, target);
      trashed.push(path);
    },
    host,
    settings,
    credentials: new CredentialStore(dataDir, fakeKeychain),
    createClient: () =>
      new StubDriver({
        script: ({ params }) => {
          if (lastUserText(params.input) === COMPACT_PROMPT) return { steps: [{ type: "message", text: "SUMMARY", phase: "final_answer" }] };
          const next = plans.shift();
          if (!next) return { steps: [{ type: "message", text: "All done.", phase: "final_answer" }] };
          return Array.isArray(next) ? { steps: next } : next;
        },
      }),
    notify: (notification) => notifications.push(notification),
    requestApproval: async (params) => {
      asked.push(params);
      return answers.shift() ?? "denied";
    },
    appVersion: "0.0.0-test",
    development: true,
  });
  servers.push(app);
  return app;
}

async function until<T>(find: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const completedTurn = (threadId: string) =>
  until(() => notifications.findLast((n): n is Extract<Notification, { method: "turn/completed" }> => n.method === "turn/completed" && n.params.threadId === threadId)?.params.turn);

const shape = (items: Item[]) => items.map((item) => `${item.type}:${"status" in item ? item.status : "-"}`);

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "aporisa-app-")));
  workspace = join(root, "work");
  dataDir = join(root, "data");
  await mkdir(workspace);
  notifications = [];
  plans = [];
  answers = [];
  asked = [];
  trashed = [];
});

/** A project for `workspace` and a chat in it. */
async function startInWorkspace(app: AppServer, settings?: ParamsOf<"thread/start">["settings"]) {
  const { project } = await app.handle("project/create", { main: workspace });
  return app.handle("thread/start", { projectId: project.id, ...(settings ? { settings } : {}) });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.dispose()));
  await rm(root, { recursive: true, force: true });
});

describe("settings and connection", () => {
  it("keeps device settings and preferences apart and never shows the key", async () => {
    const app = await server();
    expect(await app.handle("initialize", {})).toMatchObject({ protocolVersion: 1, appVersion: "0.0.0-test", dataDir });
    const initial = await app.handle("settings/read", {});
    expect(initial).toMatchObject({
      device: { language: "en", appearance: "system" },
      newThread: { effort: null, sandbox: "workspace-write", approval: "on-request", network: false },
      connection: { baseUrl: null, effectiveBaseUrl: "http://127.0.0.1:18080/v1", keyConfigured: false, keyHint: null },
    });
    const updated = await app.handle("settings/update", {
      device: { language: "zh-CN", appearance: "dark" },
      newThread: { effort: "high", network: true },
      connection: { baseUrl: "http://studio.example/v1", apiKey: "secret-key-1234" },
    });
    expect(updated).toMatchObject({ device: { language: "zh-CN", appearance: "dark" }, newThread: { effort: "high", network: true }, connection: { keyConfigured: true, keyHint: "1234", keySource: "keychain" } });
    expect(JSON.stringify(updated)).not.toContain("secret-key");
    for (const file of ["settings.json", "credentials.json", join("profiles", "local", "preferences.json")]) {
      expect((await stat(join(dataDir, file))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(dataDir, "credentials.json"), "utf8")).not.toContain("secret-key");
    expect(JSON.parse(await readFile(join(dataDir, "profiles", "local", "preferences.json"), "utf8"))).toMatchObject({ version: 1, newThread: { effort: "high" } });
    const reopened = await server();
    expect(await reopened.handle("settings/read", {})).toEqual(updated);
    expect((await reopened.handle("settings/update", { connection: { apiKey: "" } })).connection.keyConfigured).toBe(false);
  });

  it("validates params with the L3 schema", () => {
    expect(PARAMS["turn/start"].safeParse({ threadId: "t", text: "hi", images: ["data:image/gif;base64,AAAA"] }).success).toBe(false);
    expect(PARAMS["settings/update"].safeParse({ connection: { baseUrl: "not a url" } }).success).toBe(false);
    expect(PARAMS["thread/start"].safeParse({ projectId: null, extra: 1 }).success).toBe(false);
    expect(PARAMS["thread/start"].safeParse({ cwd: "/w" }).success).toBe(false);
  });
});

describe("threads and turns", () => {
  it("streams a turn as structured items", async () => {
    plans = [[{ type: "reasoning", text: "look first" }, { type: "message", text: "Reading the file.", phase: "commentary" }, call("exec_command", { cmd: "cat a.txt" })]];
    const app = await server();
    const { thread, settings } = await startInWorkspace(app);
    expect(settings).toMatchObject({ effort: "medium", sandbox: "workspace-write", approval: "on-request", network: false });
    await app.handle("turn/start", { threadId: thread.id, text: "check a.txt", images: [] });
    const turn = await completedTurn(thread.id);
    expect(turn.status).toBe("completed");
    expect(shape(turn.items)).toEqual(["userMessage:-", "reasoning:completed", "agentMessage:completed", "commandExecution:failed", "agentMessage:completed"]);
    const [user, reasoning, commentary, command, answer] = turn.items;
    expect(user).toMatchObject({ text: "check a.txt", images: [] });
    expect(reasoning).toMatchObject({ text: "look first", durationMs: expect.any(Number) });
    expect(commentary).toMatchObject({ phase: "commentary" });
    expect(command).toMatchObject({ command: "cat a.txt", actions: [{ kind: "read", path: "a.txt" }], exitCode: 1, sandboxed: true, output: expect.stringContaining("No such file") });
    expect(command).not.toMatchObject({ output: expect.stringContaining("Wall time") });
    expect(answer).toMatchObject({ text: "All done.", phase: "final_answer" });
    expect(notifications.some((n) => n.method === "item/delta" && n.params.kind === "reasoning")).toBe(true);
    expect(notifications.find((n) => n.method === "thread/contextUsage")).toMatchObject({ params: { usage: { contextWindow: 65_536 } } });

    const listed = await app.handle("thread/list", {});
    expect(listed.threads).toMatchObject([{ id: thread.id, title: "check a.txt", loaded: true, running: false }]);
  });

  it("asks the UI for approvals and shows refusals", async () => {
    plans = [[call("exec_command", { cmd: "touch made" })]];
    answers = ["denied"];
    const app = await server();
    const { thread } = await startInWorkspace(app, { approval: "untrusted" });
    await app.handle("turn/start", { threadId: thread.id, text: "go", images: [] });
    const turn = await completedTurn(thread.id);
    const command = turn.items.find((item) => item.type === "commandExecution");
    expect(asked).toMatchObject([{ threadId: thread.id, turnId: turn.id, itemId: command?.id, request: { kind: "command", command: "touch made", reason: "untrusted" } }]);
    expect(command).toMatchObject({ status: "declined" });
  });

  it("reopens a thread from its session file looking like it did live", async () => {
    plans = [[{ type: "reasoning", text: "r" }, call("exec_command", { cmd: "ls" })], [call("apply_patch", { input: "*** Begin Patch\n*** Add File: x.txt\n+x\n*** End Patch" })]];
    const first = await server();
    const { thread } = await startInWorkspace(first);
    await first.handle("turn/start", { threadId: thread.id, text: "do it", images: [] });
    const live = await completedTurn(thread.id);
    await first.dispose();

    const second = await server();
    const resumed = await second.handle("thread/resume", { threadId: thread.id });
    const turn = resumed.turns[0] as Turn;
    expect(shape(turn.items)).toEqual(shape(live.items));
    expect(turn.items.find((item) => item.type === "fileChange")).toMatchObject({ changes: [{ path: "x.txt", kind: "add" }], status: "completed" });
    expect(turn.items.find((item) => item.type === "commandExecution")).toMatchObject({ actions: [{ kind: "list", path: null }], status: "completed" });
    expect(resumed.settings).toMatchObject({ sandbox: "workspace-write", approval: "on-request" });

    notifications = [];
    await second.handle("turn/start", { threadId: thread.id, text: "again", images: [] });
    const next = await completedTurn(thread.id);
    expect(next.items[0]).toMatchObject({ type: "userMessage", text: "again" });
  });

  it("updates thread settings, compacts on request, interrupts and reports errors", async () => {
    plans = [[call("exec_command", { cmd: "sleep 30", yield_time_ms: 30_000 })]];
    const app = await server();
    const { thread } = await startInWorkspace(app);
    expect((await app.handle("thread/settings/update", { threadId: thread.id, settings: { effort: "high", network: true } })).settings).toMatchObject({ effort: "high", network: true });
    expect(notifications.find((n) => n.method === "thread/settings")).toBeDefined();

    await app.handle("turn/start", { threadId: thread.id, text: "wait", images: [] });
    await until(() => notifications.find((n) => n.method === "item/started" && n.params.item.type === "commandExecution"));
    await expect(app.handle("turn/start", { threadId: thread.id, text: "again", images: [] })).rejects.toMatchObject({ code: "busy" });
    await app.handle("turn/interrupt", { threadId: thread.id });
    expect((await completedTurn(thread.id)).status).toBe("interrupted");

    const compacted = await app.handle("thread/compact", { threadId: thread.id });
    expect(compacted).toEqual({ compacted: true, error: null });
    const compactionTurn = await completedTurn(thread.id);
    expect(compactionTurn.items).toMatchObject([{ type: "compaction", reason: "manual", status: "completed" }]);

    await expect(app.handle("turn/start", { threadId: "missing", text: "x", images: [] })).rejects.toBeInstanceOf(AppError);
    await expect(app.handle("thread/resume", { threadId: "missing" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("projects and chats (F4.5)", () => {
  const sessionLines = async (threadId: string) => {
    const path = await SessionStore.find(new NodeHost({ dataDir }).fs, defaultSessionsDir(dataDir), threadId);
    return SessionStore.read(new NodeHost({ dataDir }).fs, path as string);
  };
  const userTexts = (lines: Awaited<ReturnType<typeof sessionLines>>) =>
    lines.flatMap((line) => (line.type === "item" && line.payload.item.type === "message" && line.payload.item.role === "user" ? [line.payload.item.content.map((part) => ("text" in part ? part.text : "")).join("")] : []));

  it("keeps projects of real folders the agent may read, one per main folder", async () => {
    const app = await server();
    await mkdir(join(workspace, "sub"));
    await writeFile(join(root, "file.txt"), "x");
    await mkdir(dataDir, { recursive: true });
    const { project } = await app.handle("project/create", { main: `${workspace}/sub/..` });
    expect(project).toMatchObject({ name: "work", main: workspace, references: [] });
    expect((await app.handle("project/create", { main: workspace })).project.id).toBe(project.id);
    await expect(app.handle("project/create", { main: join(root, "missing") })).rejects.toMatchObject({ code: "not_found" });
    await expect(app.handle("project/create", { main: join(root, "file.txt") })).rejects.toMatchObject({ code: "invalid_params" });
    // The data directory is unreadable for commands, so it cannot be a project folder.
    await expect(app.handle("project/create", { main: dataDir })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(app.handle("project/update", { projectId: project.id, references: [workspace] })).rejects.toMatchObject({ code: "invalid_params" });
    const renamed = await app.handle("project/update", { projectId: project.id, name: "  Work  " });
    expect(renamed.project.name).toBe("Work");
    expect(JSON.parse(await readFile(join(dataDir, "profiles", "local", "projects.json"), "utf8"))).toMatchObject({ version: 1, projects: [{ id: project.id, name: "Work" }] });
  });

  it("tells the model about reference folders, also when they change, and when the project goes away", async () => {
    const refs = join(root, "refs");
    await mkdir(refs);
    const app = await server();
    const { project } = await app.handle("project/create", { main: workspace });
    await app.handle("project/update", { projectId: project.id, references: [refs] });
    const { thread } = await app.handle("thread/start", { projectId: project.id });
    expect(thread).toMatchObject({ cwd: workspace, projectId: project.id, scratch: false });
    let lines = await sessionLines(thread.id);
    expect(lines[0]).toMatchObject({ type: "session_meta", payload: { projectId: project.id, references: [refs] } });
    expect(userTexts(lines)[0]).toContain(`<directory>${refs}</directory>`);

    const other = join(root, "other");
    await mkdir(other);
    await app.handle("project/update", { projectId: project.id, references: [refs, other] });
    await app.handle("turn/start", { threadId: thread.id, text: "one", images: [] });
    await completedTurn(thread.id);
    lines = await sessionLines(thread.id);
    expect(lines.find((line) => line.type === "context")).toMatchObject({ payload: { references: [refs, other] } });
    const update = userTexts(lines).find((text, index) => index > 0 && text.startsWith("<environment_context>"));
    expect(update).toContain(`<directory>${other}</directory>`);

    await app.handle("project/remove", { projectId: project.id });
    expect((await app.handle("project/list", {})).projects).toEqual([]);
    expect((await app.handle("thread/list", {})).threads).toMatchObject([{ id: thread.id, projectId: null, cwd: workspace }]);
    notifications = [];
    await app.handle("turn/start", { threadId: thread.id, text: "two", images: [] });
    await completedTurn(thread.id);
    expect(userTexts(await sessionLines(thread.id)).at(-2)).toContain("<reference_directories>none</reference_directories>");
    // The folders themselves are untouched.
    expect((await stat(workspace)).isDirectory()).toBe(true);
  });

  it("gives a chat without a project its own folder and trashes both on delete", async () => {
    plans = [[call("exec_command", { cmd: "touch made.txt" })]];
    const app = await server();
    const { thread } = await app.handle("thread/start", { projectId: null });
    expect(thread).toMatchObject({ projectId: null, scratch: true });
    expect(thread.cwd.startsWith(`${join(root, "scratch")}/`)).toBe(true);
    await app.handle("turn/start", { threadId: thread.id, text: "make a file", images: [] });
    const turn = await completedTurn(thread.id);
    expect(turn.items.find((item) => item.type === "commandExecution")).toMatchObject({ exitCode: 0, sandboxed: true });
    expect((await stat(join(thread.cwd, "made.txt"))).isFile()).toBe(true);

    await app.handle("thread/delete", { threadId: thread.id });
    expect(trashed).toHaveLength(2);
    expect(trashed[0]?.endsWith(`-${thread.id}.jsonl`)).toBe(true);
    expect(trashed[1]).toBe(thread.cwd);
    expect((await app.handle("thread/list", {})).threads).toEqual([]);
    await expect(app.handle("turn/start", { threadId: thread.id, text: "x", images: [] })).rejects.toMatchObject({ code: "not_found" });
    await expect(app.handle("thread/delete", { threadId: thread.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("stops a running chat before deleting it and never trashes a project folder", async () => {
    plans = [[call("exec_command", { cmd: "sleep 30", yield_time_ms: 30_000 })]];
    const app = await server();
    const { thread } = await startInWorkspace(app);
    await app.handle("turn/start", { threadId: thread.id, text: "wait", images: [] });
    await until(() => notifications.find((n) => n.method === "item/started" && n.params.item.type === "commandExecution"));
    await app.handle("thread/delete", { threadId: thread.id });
    const after = notifications.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notifications.length).toBe(after);
    expect(trashed).toHaveLength(1);
    expect((await stat(workspace)).isDirectory()).toBe(true);
    expect((await app.handle("thread/list", {})).threads).toEqual([]);
  });

  it("groups chats recorded before projects by their folder", async () => {
    const host = new NodeHost({ shell: "/bin/sh", dataDir });
    const legacy = await Thread.start({ client: new StubDriver(), host, cwd: workspace, sessionsDir: defaultSessionsDir(dataDir) });
    await legacy.close();
    const app = await server();
    expect((await app.handle("thread/list", {})).threads).toMatchObject([{ id: legacy.id, projectId: null, scratch: false }]);
    const { project } = await app.handle("project/create", { main: workspace });
    expect((await app.handle("thread/list", {})).threads).toMatchObject([{ id: legacy.id, projectId: project.id }]);
  });
});

describe("shell environment for apps started from Finder", () => {
  it("reads env -0 output between the markers and drops shell bookkeeping", () => {
    const output = `welcome banner\n__APORISA_ENV_START__PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/me\0SHLVL=2\0EMPTY=\0__APORISA_ENV_END__trailing`;
    expect(parseEnvironment(output)).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/me", EMPTY: "" });
    expect(parseEnvironment("no markers")).toBeNull();
  });
});

describe("trusted renderer URLs for IPC", () => {
  // The installed app lives in "Aporisa Code.app": Chromium reports the frame URL
  // percent-encoded, and a raw-path prefix rejected every request ("untrusted sender").
  const appDir = "/Users/me/Applications/Aporisa Code.app/Contents/Resources/app.asar";

  it("trusts the packaged renderer even when the path has spaces or non-ASCII characters", () => {
    const page = rendererUrl(appDir, null);
    expect(page).toBe("file:///Users/me/Applications/Aporisa%20Code.app/Contents/Resources/app.asar/renderer/index.html");
    expect(isTrustedRendererUrl(page, appDir, null)).toBe(true);
    expect(isTrustedRendererUrl(`${page}#settings`, appDir, null)).toBe(true);
    const chinese = "/Users/me/项目/Aporisa Code.app/Contents/Resources/app.asar";
    expect(isTrustedRendererUrl(rendererUrl(chinese, null), chinese, null)).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isTrustedRendererUrl("file:///Users/me/Applications/Aporisa%20Code.app/Contents/Resources/app.asar/renderer-evil/x.html", appDir, null)).toBe(false);
    expect(isTrustedRendererUrl("file:///tmp/index.html", appDir, null)).toBe(false);
    expect(isTrustedRendererUrl("https://example.com/", appDir, null)).toBe(false);
    expect(isTrustedRendererUrl("not a url", appDir, null)).toBe(false);
    // The dev server is trusted only by exact origin, and only when it is configured.
    expect(isTrustedRendererUrl("http://localhost:5199/", appDir, null)).toBe(false);
    expect(isTrustedRendererUrl("http://localhost:5199/index.html", appDir, "http://localhost:5199")).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:51990/", appDir, "http://localhost:5199")).toBe(false);
    expect(isTrustedRendererUrl(rendererUrl(appDir, null), appDir, "http://localhost:5199")).toBe(false);
  });
});
