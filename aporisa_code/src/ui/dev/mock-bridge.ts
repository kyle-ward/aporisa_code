// Development only: a scripted bridge so the renderer can be checked in a plain browser
// (Vite dev server, no Electron). Never part of a production build (bridge.ts imports it
// only under import.meta.env.DEV). Not a product mode.
import type {
  AporisaBridge,
  ApprovalDecision,
  ClientMethod,
  Item,
  Notification,
  ParamsOf,
  ProjectInfo,
  ResultOf,
  ServerRequest,
  SettingsView,
  ThreadInfo,
  ThreadSettings,
  Turn,
} from "../../app-protocol/types.ts";

const CWD = "/Users/demo/projects/inventory-service";

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function finishedTurn(): Turn {
  return {
    id: "turn-history",
    startedAt: iso(-8 * 60_000),
    completedAt: iso(-8 * 60_000 + 479_000),
    status: "completed",
    error: null,
    truncated: false,
    items: [
      { type: "userMessage", id: "u1", text: "把第三基线冻结下来，同步到公开生成链路，并更新校验清单。", images: [] },
      { type: "reasoning", id: "r1", text: "The user wants the third baseline frozen. First find where baselines live and how manifests reference them.", durationMs: 6_000, status: "completed" },
      { type: "agentMessage", id: "c1", text: "我会将 `icd_applicability_open_v1.txt` 冻结为第三基线，同步到公开生成和诊断链路并更新校验清单。", phase: "commentary", status: "completed" },
      {
        type: "commandExecution",
        id: "x1",
        command: "git status --short; cat backend/src/assets/manifest.json backend/resources/diagnostics/manifest.json",
        cwd: CWD,
        actions: [{ kind: "run", command: "git status --short; cat backend/src/assets/manifest.json" }],
        status: "completed",
        exitCode: 0,
        durationMs: 40,
        sandboxed: true,
        escalated: false,
        output: ' M backend/tests/test_generation.py\n{\n  "baselines": ["direct_baseline_1.txt", "direct_baseline_2.txt"]\n}\n',
        sessionId: null,
      },
      { type: "commandExecution", id: "x2", command: "sed -n '1,120p' documentation.py", cwd: CWD, actions: [{ kind: "read", path: "documentation.py" }], status: "completed", exitCode: 0, durationMs: 12, sandboxed: true, escalated: false, output: '"""Documentation helpers."""\n\nimport json\n', sessionId: null },
      { type: "commandExecution", id: "x3", command: 'rg -n "第二基线|049707" docs', cwd: CWD, actions: [{ kind: "search", query: "第二基线|049707", path: "docs" }], status: "completed", exitCode: 0, durationMs: 30, sandboxed: true, escalated: false, output: "docs/research/notes.md:12: 第二基线 049707…\n", sessionId: null },
      { type: "agentMessage", id: "c2", text: "模板我会按栏目职责写简短说明，不加入诊断推断或选码规则。", phase: "commentary", status: "completed" },
      {
        type: "fileChange",
        id: "p1",
        changes: [{ path: "docs/research/prompts/direct_baseline_3.txt", kind: "add" }, { path: "backend/src/assets/manifest.json", kind: "update" }],
        patch: '*** Begin Patch\n*** Add File: docs/research/prompts/direct_baseline_3.txt\n+ICD-10 Codes:\n*** Update File: backend/src/assets/manifest.json\n@@\n-  "baselines": ["direct_baseline_1.txt", "direct_baseline_2.txt"]\n+  "baselines": ["direct_baseline_1.txt", "direct_baseline_2.txt", "direct_baseline_3.txt"]\n*** End Patch',
        status: "completed",
        message: null,
      },
      { type: "commandExecution", id: "x4", command: "./scripts/check.sh", cwd: CWD, actions: [{ kind: "run", command: "./scripts/check.sh" }], status: "completed", exitCode: 0, durationMs: 92_000, sandboxed: true, escalated: false, output: "546 passed\n", sessionId: null },
      {
        type: "agentMessage",
        id: "a1",
        text: "已完成。\n\n**第三基线已冻结**为 `direct_baseline_3.txt`，与 `icd_applicability_open_v1.txt` 原字节一致。公开 prompt、CLI 默认版本及两个 manifest 已同步；第二基线保留。\n\n- 其余 18 个占位符替换为一句简短栏目说明\n- 不新增诊断、选码或覆盖要求\n\n> 注意：这是源码与资源层的更新，后台服务尚未重启。",
        phase: "final_answer",
        status: "completed",
      },
    ],
  };
}

const SCRATCH = "/Users/demo/Library/Caches/Aporisa Code/scratch";

const PROJECTS: ProjectInfo[] = [
  { id: "p-inventory", name: "inventory-service", main: CWD, references: ["/Users/demo/projects/shared-schemas"], createdAt: iso(-30 * 86_400_000) },
  { id: "p-web", name: "web-app", main: "/Users/demo/projects/web-app", references: [], createdAt: iso(-20 * 86_400_000) },
  { id: "p-empty", name: "notes", main: "/Users/demo/notes", references: [], createdAt: iso(-2 * 86_400_000) },
];

const THREADS: ThreadInfo[] = [
  { id: "demo-1", title: "把第三基线冻结下来，同步到公开生成链路", cwd: CWD, projectId: "p-inventory", scratch: false, model: "aporisa-local-v0", createdAt: iso(-9 * 60_000), updatedAt: Date.now() - 60_000, loaded: false, running: false },
  { id: "demo-2", title: "Fix the flaky upload test", cwd: "/Users/demo/projects/web-app", projectId: "p-web", scratch: false, model: "aporisa-local-v0", createdAt: iso(-86_400_000), updatedAt: Date.now() - 3 * 3_600_000, loaded: false, running: false },
  { id: "demo-3", title: "Explain how HTTP caching headers interact", cwd: `${SCRATCH}/a1b2`, projectId: null, scratch: true, model: "aporisa-local-v0", createdAt: iso(-3 * 86_400_000), updatedAt: Date.now() - 16 * 86_400_000, loaded: false, running: false },
];

/** Folders the fake folder picker hands out in turn. */
const PICKS = ["/Users/demo/projects/shared-schemas", "/Users/demo/projects/new-tool", "/Users/demo/projects/docs-site"];

export function createMockBridge(): AporisaBridge {
  const notificationListeners = new Set<(notification: Notification) => void>();
  const requestListeners = new Set<(request: ServerRequest) => void>();
  const answers = new Map<number, (decision: ApprovalDecision) => void>();
  let settings: SettingsView = {
    device: { language: "en", appearance: "system" },
    newThread: { effort: null, sandbox: "workspace-write", approval: "on-request", network: false },
    connection: { baseUrl: null, effectiveBaseUrl: "http://127.0.0.1:18080/v1", keyConfigured: true, keyHint: "8f2a", keySource: "keychain" },
  };
  const threadSettings: ThreadSettings = { effort: "medium", sandbox: "workspace-write", approval: "on-request", network: false };
  let interrupted = false;
  let projects = PROJECTS.map((project) => ({ ...project, references: [...project.references] }));
  let threads = THREADS.map((thread) => ({ ...thread }));
  let picks = 0;
  const findThread = (id: string) => threads.find((thread) => thread.id === id);

  const notify = (notification: Notification) => {
    for (const listener of notificationListeners) listener(notification);
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function runScript(threadId: string, text: string, images: string[]) {
    interrupted = false;
    const turnId = `turn-${Date.now()}`;
    const turn: Turn = { id: turnId, startedAt: new Date().toISOString(), completedAt: null, status: "running", error: null, truncated: false, items: [{ type: "userMessage", id: `u-${turnId}`, text, images }] };
    notify({ method: "turn/started", params: { threadId, turn } });
    const items = new Map<string, Item>(turn.items.map((item) => [item.id, item]));
    const start = (item: Item) => {
      items.set(item.id, item);
      notify({ method: "item/started", params: { threadId, turnId, item } });
    };
    const complete = (item: Item) => {
      items.set(item.id, item);
      notify({ method: "item/completed", params: { threadId, turnId, item } });
    };
    const stream = async (id: string, kind: "text" | "reasoning", value: string) => {
      for (const word of value.split(/(?<= )/)) {
        if (interrupted) return;
        notify({ method: "item/delta", params: { threadId, turnId, itemId: id, kind, delta: word } });
        await wait(35);
      }
    };
    const reasoning = "Let me look at the repository layout first, then find where uploads are retried.";
    start({ type: "reasoning", id: "r", text: "", durationMs: null, status: "running" });
    await stream("r", "reasoning", reasoning);
    complete({ type: "reasoning", id: "r", text: reasoning, durationMs: 2_400, status: "completed" });
    const commentary = "I'll read the upload module and its test, then run the test a few times.";
    start({ type: "agentMessage", id: "c", text: "", phase: null, status: "running" });
    await stream("c", "text", commentary);
    complete({ type: "agentMessage", id: "c", text: commentary, phase: "commentary", status: "completed" });
    const read: Item = { type: "commandExecution", id: "x1", command: "cat src/upload.ts tests/upload.test.ts", cwd: CWD, actions: [{ kind: "read", path: "src/upload.ts" }, { kind: "read", path: "tests/upload.test.ts" }], status: "running", exitCode: null, durationMs: null, sandboxed: null, escalated: false, output: "", sessionId: null };
    start(read);
    await wait(500);
    complete({ ...read, status: "completed", exitCode: 0, durationMs: 31, sandboxed: true, output: "export async function upload(file: File) {\n  // retries twice\n}\n" });
    const search: Item = { type: "commandExecution", id: "x2", command: 'rg -n "retry" src', cwd: CWD, actions: [{ kind: "search", query: "retry", path: "src" }], status: "running", exitCode: null, durationMs: null, sandboxed: null, escalated: false, output: "", sessionId: null };
    start(search);
    await wait(400);
    complete({ ...search, status: "completed", exitCode: 0, durationMs: 18, sandboxed: true, output: "src/upload.ts:4:  // retries twice\n" });
    if (interrupted) return finish();
    const install: Item = { type: "commandExecution", id: "x3", command: "npm install", cwd: CWD, actions: [{ kind: "run", command: "npm install" }], status: "running", exitCode: null, durationMs: null, sandboxed: null, escalated: true, output: "", sessionId: null };
    start(install);
    const id = Date.now();
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      answers.set(id, resolve);
      for (const listener of requestListeners) {
        listener({
          id,
          method: "approval/request",
          params: { threadId, turnId, itemId: "x3", request: { kind: "command", command: "npm install", cwd: CWD, reason: "escalation", sandboxed: false, justification: "Do you want to install the project's npm dependencies?", rememberPrefixes: [["npm", "install"]] } },
        });
      }
    });
    if (decision === "denied") complete({ ...install, status: "declined", output: "The user declined to run this command outside the sandbox." });
    else complete({ ...install, status: "completed", exitCode: 0, durationMs: 6_200, sandboxed: false, output: "added 214 packages in 6s\n" });
    const patch: Item = { type: "fileChange", id: "p1", changes: [{ path: "src/upload.ts", kind: "update" }], patch: "*** Begin Patch\n*** Update File: src/upload.ts\n@@\n-  // retries twice\n+  await retry(() => send(file), { attempts: 3, backoffMs: 200 });\n*** End Patch", status: "running", message: null };
    start(patch);
    await wait(300);
    complete({ ...patch, status: "completed" });
    start({ type: "plan", id: "plan", explanation: null, plan: [{ step: "Read upload code", status: "completed" }, { step: "Add backoff to retries", status: "completed" }, { step: "Run the test 20 times", status: "in_progress" }] });
    const answer = "The test was flaky because `upload()` retried immediately. It now retries **3 times with a 200 ms backoff**.\n\n```ts\nawait retry(() => send(file), { attempts: 3, backoffMs: 200 });\n```\n\nThe test passed 20 runs in a row.";
    start({ type: "agentMessage", id: "a", text: "", phase: null, status: "running" });
    await stream("a", "text", answer);
    complete({ type: "agentMessage", id: "a", text: answer, phase: "final_answer", status: "completed" });
    return finish();

    function finish() {
      notify({ method: "turn/completed", params: { threadId, turn: { ...turn, status: interrupted ? "interrupted" : "completed", completedAt: new Date().toISOString(), items: [...items.values()] } } });
      notify({ method: "thread/contextUsage", params: { threadId, usage: { tokens: 23_400, contextWindow: 262_144, compactAt: 194_634 } } });
    }
  }

  const handlers: { [M in ClientMethod]: (params: ParamsOf<M>) => Promise<ResultOf<M>> } = {
    initialize: async () => ({ protocolVersion: 1, appVersion: "0.1.0-dev", dataDir: "/Users/demo/Library/Application Support/Aporisa Code", development: true }),
    "settings/read": async () => settings,
    "settings/update": async (params) => {
      settings = {
        ...settings,
        device: { ...settings.device, ...params.device },
        newThread: { ...settings.newThread, ...params.newThread },
        connection: params.connection?.apiKey === "" ? { ...settings.connection, keyConfigured: false, keyHint: null, keySource: null } : settings.connection,
      };
      return settings;
    },
    "connection/test": async () => ({ ok: true, models: ["aporisa-local-v0"] }),
    "model/list": async () => ({ models: [{ id: "aporisa-local-v0", contextWindow: 262_144, efforts: ["none", "low", "medium", "high"], defaultEffort: "medium", images: true }] }),
    "project/list": async () => ({ projects }),
    "project/create": async (params) => {
      const existing = projects.find((project) => project.main === params.main);
      if (existing) return { project: existing };
      const project: ProjectInfo = { id: `p-${Date.now()}`, name: params.main.slice(params.main.lastIndexOf("/") + 1), main: params.main, references: [], createdAt: new Date().toISOString() };
      projects = [...projects, project];
      return { project };
    },
    "project/update": async (params) => {
      const project = projects.find((entry) => entry.id === params.projectId);
      if (!project) throw new Error(`no project ${params.projectId}`);
      if (params.references?.includes(project.main)) throw new Error("the main folder cannot also be a reference folder");
      const updated = { ...project, ...(params.name ? { name: params.name.trim() } : {}), ...(params.references ? { references: [...new Set(params.references)] } : {}) };
      projects = projects.map((entry) => (entry.id === project.id ? updated : entry));
      return { project: updated };
    },
    "project/remove": async (params) => {
      projects = projects.filter((project) => project.id !== params.projectId);
      threads = threads.map((thread) => (thread.projectId === params.projectId ? { ...thread, projectId: null } : thread));
      return {};
    },
    "thread/list": async () => ({ threads }),
    "thread/start": async (params) => {
      const project = projects.find((entry) => entry.id === params.projectId);
      const id = `demo-${Date.now()}`;
      const thread: ThreadInfo = {
        id,
        title: "",
        cwd: project?.main ?? `${SCRATCH}/${id}`,
        projectId: project?.id ?? null,
        scratch: !project,
        model: "aporisa-local-v0",
        createdAt: new Date().toISOString(),
        updatedAt: Date.now(),
        loaded: true,
        running: false,
      };
      threads = [...threads, thread];
      return { thread, settings: threadSettings, turns: [] };
    },
    "thread/delete": async (params) => {
      threads = threads.filter((thread) => thread.id !== params.threadId);
      return {};
    },
    "thread/resume": async (params) => {
      const thread = findThread(params.threadId) ?? threads[0];
      const turns = params.threadId === "demo-1" ? [finishedTurn()] : [{ ...finishedTurn(), id: "t2", status: "interrupted" as const, items: finishedTurn().items.slice(0, 5) }];
      setTimeout(() => notify({ method: "thread/contextUsage", params: { threadId: params.threadId, usage: { tokens: 48_200, contextWindow: 262_144, compactAt: 194_634 } } }), 50);
      return { thread: { ...(thread as ThreadInfo), loaded: true }, settings: threadSettings, turns };
    },
    "thread/settings/update": async (params) => {
      Object.assign(threadSettings, params.settings);
      notify({ method: "thread/settings", params: { threadId: params.threadId, settings: { ...threadSettings } } });
      return { settings: { ...threadSettings } };
    },
    "thread/compact": async () => ({ compacted: true, error: null }),
    "turn/start": async (params) => {
      const thread = findThread(params.threadId);
      if (thread) {
        thread.title ||= params.text.slice(0, 60);
        notify({ method: "thread/updated", params: { thread: { ...thread, updatedAt: Date.now(), running: true, loaded: true } } });
      }
      void runScript(params.threadId, params.text, params.images);
      return {};
    },
    "turn/interrupt": async () => {
      interrupted = true;
      return {};
    },
    "dialog/selectFolder": async () => ({ path: PICKS[picks++ % PICKS.length] ?? CWD }),
    "shell/reveal": async () => ({}),
  };

  return {
    request(method, params) {
      return (handlers[method] as (params: unknown) => Promise<never>)(params);
    },
    onNotification(listener) {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onServerRequest(listener) {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    respond(id, result) {
      answers.get(id)?.(result.decision);
      answers.delete(id);
    },
  };
}
