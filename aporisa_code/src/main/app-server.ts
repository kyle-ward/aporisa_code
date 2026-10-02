// The app's main-process server (DEVELOPMENT_PLAN.md 10.3): it hosts the harness and
// answers the L3 requests. Plain Node with injected dependencies, so it runs headless in
// tests; electron.ts wires it to IPC, the keychain and native dialogs.
import {
  APP_PROTOCOL_VERSION,
  type ApprovalDecision,
  type ApprovalRequest as AppApprovalRequest,
  type AppErrorShape,
  type ClientMethod,
  type ContextUsage,
  type ModelView,
  type Notification,
  type ParamsOf,
  type ProjectInfo,
  type ResultOf,
  type SettingsView,
  type ThreadInfo,
  type ThreadSettings,
  type Turn,
} from "../app-protocol/index.ts";
import {
  autoCompactThreshold,
  defaultSessionsDir,
  resolveSafety,
  SessionStore,
  Thread,
  type ApprovalRequest,
  type ThreadEvent,
  type UserInput,
} from "../harness/index.ts";
import type { Host } from "../host/index.ts";
import type { Model } from "../protocol/index.ts";
import type { AporisaClient, ApiKey } from "../sdk/index.ts";
import type { CredentialStore } from "./credentials.ts";
import type { ProjectStore } from "./projects.ts";
import { LiveProjector, projectSession } from "./projection.ts";
import { DEFAULT_BASE_URL, type SettingsStore } from "./settings.ts";

export class AppError extends Error {
  readonly code: AppErrorShape["code"];
  constructor(code: AppErrorShape["code"], message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export interface AppServerOptions {
  host: Host;
  settings: SettingsStore;
  credentials: CredentialStore;
  createClient(baseUrl: string, apiKey: ApiKey): AporisaClient;
  notify(notification: Notification): void;
  /** Asks the UI (a server request); resolves with its answer. */
  requestApproval(params: { threadId: string; turnId: string; itemId: string; request: AppApprovalRequest }): Promise<ApprovalDecision>;
  selectFolder?(): Promise<string | null>;
  reveal?(path: string): void;
  projects: ProjectStore;
  /**
   * Where chats without a project get their private folders (FD-28). Outside the data
   * directory, which the sandbox does not let commands read.
   */
  scratchDir: string;
  /** Moves a file or folder to the Trash (FD-26). */
  trash(path: string): Promise<void>;
  appVersion: string;
  development: boolean;
  /** Development fallbacks from aporisa_code/.env. */
  envBaseUrl?: string | null;
  envModel?: string | null;
  sessionsDir?: string;
}

interface Loaded {
  thread: Thread;
  client: AporisaClient;
  projector: LiveProjector;
  settings: ThreadSettings;
  controller: AbortController | null;
  /** The call an approval is about (approval.requested precedes the question). */
  pendingCall: { turnId: string; callId: string } | null;
  /** SessionMeta.projectId as recorded (undefined: before projects, or from the CLI). */
  recordedProject: string | null | undefined;
  /** The running turn, awaited before a chat is deleted. */
  turn: Promise<unknown> | null;
  /** Deleted: its events are no longer shown. */
  deleted: boolean;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

const CONNECTION = "local";

function toAppRequest(request: ApprovalRequest): AppApprovalRequest {
  return request;
}

export class AppServer {
  private readonly options: AppServerOptions;
  private readonly threads = new Map<string, Loaded>();
  private readonly sessionsDir: string;
  private scratchRootPromise: Promise<string> | null = null;

  constructor(options: AppServerOptions) {
    this.options = options;
    this.sessionsDir = options.sessionsDir ?? defaultSessionsDir(options.host.info().dataDir);
  }

  async handle<M extends ClientMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const handler = (this.handlers as Record<string, (params: unknown) => Promise<unknown>>)[method];
    if (!handler) throw new AppError("unknown_method", `unknown method ${method}`);
    return (await handler.call(this, params)) as ResultOf<M>;
  }

  /** Stops every thread's processes and finishes writing their session records. */
  async dispose(): Promise<void> {
    for (const loaded of this.threads.values()) loaded.controller?.abort();
    await Promise.all([...this.threads.values()].map(async (loaded) => {
      await loaded.thread.close();
      await loaded.client.close();
    }));
    this.threads.clear();
  }

  // --- connection ------------------------------------------------------------------------

  private baseUrl(): string {
    return this.options.settings.snapshot().baseUrl ?? this.options.envBaseUrl ?? DEFAULT_BASE_URL;
  }

  private client(): AporisaClient {
    // The key is looked up per request, so a key changed in Settings applies at once.
    return this.options.createClient(this.baseUrl(), async () => {
      const key = await this.options.credentials.get(CONNECTION);
      if (!key) throw new AppError("connection", "no API key is configured");
      return key;
    });
  }

  private async settingsView(): Promise<SettingsView> {
    const snapshot = this.options.settings.snapshot();
    const key = await this.options.credentials.describe(CONNECTION);
    return {
      device: snapshot.device,
      newThread: snapshot.newThread,
      connection: { baseUrl: snapshot.baseUrl, effectiveBaseUrl: this.baseUrl(), keyConfigured: key.configured, keyHint: key.hint, keySource: key.source },
    };
  }

  private async models(client: AporisaClient): Promise<Model[]> {
    try {
      return await client.listModels();
    } catch (error) {
      throw new AppError("connection", (error as Error).message);
    }
  }

  private static modelView(model: Model): ModelView {
    return {
      id: model.id,
      contextWindow: model.context_window,
      efforts: [...model.reasoning.supported_efforts],
      defaultEffort: model.reasoning.default_effort,
      images: model.input_modalities.includes("image"),
    };
  }

  // --- threads ---------------------------------------------------------------------------

  private loaded(threadId: string): Loaded {
    const loaded = this.threads.get(threadId);
    if (!loaded) throw new AppError("not_found", `thread ${threadId} is not open`);
    return loaded;
  }

  // --- projects and folders (F4.5) --------------------------------------------------------

  /** The scratch root, created on first use and resolved like thread cwds are. */
  private scratchRoot(): Promise<string> {
    this.scratchRootPromise ??= (async () => {
      await this.options.host.fs.mkdir(this.options.scratchDir, { mode: 0o700 });
      return this.options.host.fs.realpath(this.options.scratchDir);
    })();
    return this.scratchRootPromise;
  }

  private async isScratch(cwd: string): Promise<boolean> {
    return within(cwd, await this.scratchRoot()) && cwd !== (await this.scratchRoot());
  }

  /**
   * Which project a chat belongs to: the recorded one while it exists; a chat whose project
   * was removed has none (FD-27); a chat recorded before projects matches by main folder.
   */
  private projectOf(recorded: string | null | undefined, cwd: string): ProjectInfo | null {
    if (recorded === null) return null;
    if (recorded !== undefined) return this.options.projects.get(recorded);
    return this.options.projects.byMain(cwd);
  }

  /** A folder the user picked: its real path, if it is a directory the agent may read. */
  private async checkFolder(path: string): Promise<string> {
    const fs = this.options.host.fs;
    if (!path.startsWith("/")) throw new AppError("invalid_params", `not an absolute path: ${path}`);
    let real: string;
    try {
      real = await fs.realpath(path);
    } catch {
      throw new AppError("not_found", `folder not found: ${path}`);
    }
    if ((await fs.stat(real))?.kind !== "directory") throw new AppError("invalid_params", `not a folder: ${path}`);
    const policy = await resolveSafety({}, real, fs, this.options.host.info());
    if (policy.denyPaths.some((denied) => within(real, denied))) throw new AppError("invalid_params", `the agent may not read this folder: ${path}`);
    if (within(real, await this.scratchRoot())) throw new AppError("invalid_params", `this folder belongs to a chat: ${path}`);
    return real;
  }

  /** Tells the open chats of a project about their reference folders (next turn). */
  private retellReferences(): void {
    for (const loaded of this.threads.values()) {
      const project = this.projectOf(loaded.recordedProject, loaded.thread.cwd);
      loaded.thread.setReferences(project?.references ?? []);
    }
  }

  private async info(loaded: Loaded): Promise<ThreadInfo> {
    const first = loaded.projector.turns.flatMap((turn) => turn.items).find((item) => item.type === "userMessage");
    return {
      id: loaded.thread.id,
      title: first?.type === "userMessage" ? first.text.replace(/\s+/g, " ").trim().slice(0, 120) : "",
      cwd: loaded.thread.cwd,
      projectId: this.projectOf(loaded.recordedProject, loaded.thread.cwd)?.id ?? null,
      scratch: await this.isScratch(loaded.thread.cwd),
      model: loaded.thread.model.id,
      createdAt: loaded.projector.turns[0]?.startedAt ?? new Date().toISOString(),
      updatedAt: Date.now(),
      loaded: true,
      running: loaded.thread.busy,
    };
  }

  private async emitUsage(loaded: Loaded, tokens?: number): Promise<void> {
    const model = loaded.thread.model;
    const usage: ContextUsage = {
      tokens: tokens ?? (await loaded.thread.contextTokens().catch(() => 0)),
      contextWindow: model.context_window,
      compactAt: autoCompactThreshold(model, undefined),
    };
    this.options.notify({ method: "thread/contextUsage", params: { threadId: loaded.thread.id, usage } });
  }

  private listener(getLoaded: () => Loaded | undefined) {
    return (event: ThreadEvent) => {
      const loaded = getLoaded();
      if (!loaded || loaded.deleted) return;
      loaded.projector.handle(event);
      const threadId = loaded.thread.id;
      switch (event.type) {
        case "approval.requested":
          loaded.pendingCall = { turnId: event.turnId, callId: event.callId };
          break;
        case "response.completed":
          if (event.usage) void this.emitUsage(loaded, event.usage.input_tokens + event.usage.output_tokens);
          break;
        case "compaction.completed":
          if (event.compacted) void this.emitUsage(loaded, event.tokensAfter);
          break;
        case "warning":
          this.options.notify({ method: "warning", params: { threadId, message: event.message } });
          break;
        case "turn.completed":
          loaded.controller = null;
          void this.info(loaded).then((thread) => {
            if (!loaded.deleted) this.options.notify({ method: "thread/updated", params: { thread } });
          });
          break;
        default:
          break;
      }
    };
  }

  private approver(getLoaded: () => Loaded | undefined) {
    return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      const loaded = getLoaded();
      if (!loaded?.pendingCall) return "denied";
      const { turnId, callId } = loaded.pendingCall;
      return this.options.requestApproval({ threadId: loaded.thread.id, turnId, itemId: callId, request: toAppRequest(request) });
    };
  }

  private async open(
    start: (hooks: { listener: (event: ThreadEvent) => void; approve: (request: ApprovalRequest) => Promise<ApprovalDecision> }, client: AporisaClient) => Promise<Thread>,
    history: Turn[],
    settingsOf: (thread: Thread) => ThreadSettings,
    recordedProject: string | null | undefined,
  ): Promise<Loaded> {
    const client = this.client();
    let loaded: Loaded | undefined;
    let buffered: ThreadEvent[] = [];
    const listener = this.listener(() => loaded);
    const hooks = {
      listener: (event: ThreadEvent) => (loaded ? listener(event) : buffered.push(event)),
      approve: this.approver(() => loaded),
    };
    let thread: Thread;
    try {
      thread = await start(hooks, client);
    } catch (error) {
      await client.close();
      throw error instanceof AppError ? error : new AppError("connection", (error as Error).message);
    }
    loaded = {
      thread,
      client,
      projector: new LiveProjector(thread.id, this.options.notify, history),
      settings: settingsOf(thread),
      controller: null,
      pendingCall: null,
      recordedProject,
      turn: null,
      deleted: false,
    };
    this.threads.set(thread.id, loaded);
    for (const event of buffered) listener(event);
    buffered = [];
    void this.emitUsage(loaded);
    return loaded;
  }

  private handlers = {
    initialize: async (): Promise<ResultOf<"initialize">> => ({
      protocolVersion: APP_PROTOCOL_VERSION,
      appVersion: this.options.appVersion,
      dataDir: this.options.host.info().dataDir,
      development: this.options.development,
    }),

    "settings/read": async (): Promise<ResultOf<"settings/read">> => this.settingsView(),

    "settings/update": async (params: ParamsOf<"settings/update">): Promise<ResultOf<"settings/update">> => {
      await this.options.settings.update({
        ...(params.device ? { device: params.device } : {}),
        ...(params.newThread ? { newThread: params.newThread } : {}),
        ...(params.connection?.baseUrl !== undefined ? { baseUrl: params.connection.baseUrl } : {}),
      });
      if (params.connection?.apiKey !== undefined) await this.options.credentials.set(CONNECTION, params.connection.apiKey);
      return this.settingsView();
    },

    "connection/test": async (): Promise<ResultOf<"connection/test">> => {
      const client = this.client();
      try {
        return { ok: true, models: (await client.listModels()).map((model) => model.id) };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      } finally {
        await client.close();
      }
    },

    "model/list": async (): Promise<ResultOf<"model/list">> => {
      const client = this.client();
      try {
        return { models: (await this.models(client)).map(AppServer.modelView) };
      } finally {
        await client.close();
      }
    },

    "project/list": async (): Promise<ResultOf<"project/list">> => ({ projects: this.options.projects.list() }),

    "project/create": async (params: ParamsOf<"project/create">): Promise<ResultOf<"project/create">> => {
      const main = await this.checkFolder(params.main);
      return { project: await this.options.projects.create(main, basename(main), new Date()) };
    },

    "project/update": async (params: ParamsOf<"project/update">): Promise<ResultOf<"project/update">> => {
      const project = this.options.projects.get(params.projectId);
      if (!project) throw new AppError("not_found", `no project ${params.projectId}`);
      let references: string[] | undefined;
      if (params.references !== undefined) {
        references = [];
        for (const path of params.references) {
          const real = await this.checkFolder(path);
          if (real === project.main) throw new AppError("invalid_params", "the main folder cannot also be a reference folder");
          if (!references.includes(real)) references.push(real);
        }
      }
      const updated = await this.options.projects.update(project.id, {
        ...(params.name !== undefined ? { name: params.name.trim() } : {}),
        ...(references !== undefined ? { references } : {}),
      });
      if (references !== undefined) this.retellReferences();
      return { project: updated };
    },

    "project/remove": async (params: ParamsOf<"project/remove">): Promise<ResultOf<"project/remove">> => {
      if (!(await this.options.projects.remove(params.projectId))) throw new AppError("not_found", `no project ${params.projectId}`);
      // Its chats now have no project, and so no reference folders.
      this.retellReferences();
      return {};
    },

    "thread/list": async (): Promise<ResultOf<"thread/list">> => {
      const summaries = await SessionStore.list(this.options.host.fs, this.sessionsDir);
      const threads: ThreadInfo[] = [];
      for (const summary of summaries) {
        const loaded = this.threads.get(summary.id);
        threads.push({
          id: summary.id,
          title: summary.title,
          cwd: summary.cwd,
          projectId: this.projectOf(summary.projectId, summary.cwd)?.id ?? null,
          scratch: await this.isScratch(summary.cwd),
          model: summary.model,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          loaded: loaded !== undefined,
          running: loaded?.thread.busy ?? false,
        });
      }
      return { threads };
    },

    "thread/start": async (params: ParamsOf<"thread/start">): Promise<ResultOf<"thread/start">> => {
      const defaults = this.options.settings.snapshot().newThread;
      const wanted = { ...defaults, ...params.settings };
      let cwd: string;
      let references: string[] = [];
      if (params.projectId !== null) {
        const project = this.options.projects.get(params.projectId);
        if (!project) throw new AppError("not_found", `no project ${params.projectId}`);
        cwd = project.main;
        references = project.references;
      } else {
        cwd = `${await this.scratchRoot()}/${crypto.randomUUID()}`;
        await this.options.host.fs.mkdir(cwd, { mode: 0o700 });
      }
      const loaded = await this.open(
        (hooks, client) =>
          Thread.start({
            client,
            host: this.options.host,
            cwd,
            references,
            projectId: params.projectId,
            sessionsDir: this.sessionsDir,
            ...(this.options.envModel ? { model: this.options.envModel } : {}),
            ...(wanted.effort ? { effort: wanted.effort } : {}),
            safety: { sandbox: wanted.sandbox, approval: wanted.approval, network: wanted.network },
            listener: hooks.listener,
            approve: hooks.approve,
          }),
        [],
        (thread) => ({ effort: thread.effort, sandbox: wanted.sandbox, approval: wanted.approval, network: wanted.network }),
        params.projectId,
      );
      const thread = await this.info(loaded);
      this.options.notify({ method: "thread/started", params: { thread, settings: loaded.settings } });
      return { thread, settings: loaded.settings, turns: [] };
    },

    "thread/resume": async (params: ParamsOf<"thread/resume">): Promise<ResultOf<"thread/resume">> => {
      const existing = this.threads.get(params.threadId);
      if (existing) return { thread: await this.info(existing), settings: existing.settings, turns: existing.projector.turns };
      const path = await SessionStore.find(this.options.host.fs, this.sessionsDir, params.threadId);
      if (!path) throw new AppError("not_found", `no session ${params.threadId}`);
      const lines = await SessionStore.read(this.options.host.fs, path);
      const session = await SessionStore.load(this.options.host.fs, path);
      const saved = session.safety;
      const safety = {
        sandbox: (saved?.sandbox ?? "workspace-write") as ThreadSettings["sandbox"],
        approval: (saved?.approval ?? "on-request") as ThreadSettings["approval"],
        network: saved?.network ?? false,
      };
      const recorded = session.meta.projectId;
      const project = this.projectOf(recorded, session.meta.cwd);
      const loaded = await this.open(
        (hooks, client) =>
          Thread.resume({
            client,
            host: this.options.host,
            session: path,
            sessionsDir: this.sessionsDir,
            safety,
            references: project?.references ?? [],
            listener: hooks.listener,
            approve: hooks.approve,
          }),
        projectSession(lines),
        (thread) => ({ effort: thread.effort, ...safety }),
        recorded,
      );
      return { thread: await this.info(loaded), settings: loaded.settings, turns: loaded.projector.turns };
    },

    "thread/delete": async (params: ParamsOf<"thread/delete">): Promise<ResultOf<"thread/delete">> => {
      const path = await SessionStore.find(this.options.host.fs, this.sessionsDir, params.threadId);
      const loaded = this.threads.get(params.threadId);
      if (!path && !loaded) throw new AppError("not_found", `no session ${params.threadId}`);
      let cwd = loaded?.thread.cwd ?? null;
      if (loaded) {
        // Stop it and let the record be written completely before it moves.
        loaded.deleted = true;
        loaded.controller?.abort();
        await loaded.turn?.catch(() => undefined);
        await loaded.thread.close();
        await loaded.client.close();
        this.threads.delete(params.threadId);
      }
      if (path) {
        cwd ??= (await SessionStore.load(this.options.host.fs, path)).meta.cwd;
        await this.options.trash(path);
      }
      // A chat's private folder goes with it; a project's folders are never touched.
      if (cwd !== null && (await this.isScratch(cwd)) && (await this.options.host.fs.stat(cwd))) await this.options.trash(cwd);
      return {};
    },

    "thread/settings/update": async (params: ParamsOf<"thread/settings/update">): Promise<ResultOf<"thread/settings/update">> => {
      const loaded = this.loaded(params.threadId);
      const next = { ...loaded.settings, ...params.settings };
      if (params.settings.effort && params.settings.effort !== loaded.settings.effort) loaded.thread.setEffort(params.settings.effort);
      const { sandbox, approval, network } = params.settings;
      if (sandbox !== undefined || approval !== undefined || network !== undefined) {
        loaded.thread.setSafety({ ...(sandbox ? { sandbox } : {}), ...(approval ? { approval } : {}), ...(network !== undefined ? { network } : {}) });
      }
      loaded.settings = next;
      this.options.notify({ method: "thread/settings", params: { threadId: params.threadId, settings: next } });
      return { settings: next };
    },

    "thread/compact": async (params: ParamsOf<"thread/compact">): Promise<ResultOf<"thread/compact">> => {
      const loaded = this.loaded(params.threadId);
      if (loaded.thread.busy) throw new AppError("busy", "the thread is running a turn");
      const result = await loaded.thread.compact();
      return { compacted: result.compacted, error: result.error ?? null };
    },

    "turn/start": async (params: ParamsOf<"turn/start">): Promise<ResultOf<"turn/start">> => {
      const loaded = this.loaded(params.threadId);
      if (loaded.thread.busy) throw new AppError("busy", "the thread is already running a turn");
      const input: UserInput = [
        ...(params.text.trim() !== "" ? [{ type: "input_text" as const, text: params.text }] : []),
        ...params.images.map((image) => ({ type: "input_image" as const, image_url: image, detail: "auto" as const })),
      ];
      if (input.length === 0) throw new AppError("invalid_params", "the message is empty");
      loaded.projector.expectTurn(params.text, params.images);
      const controller = new AbortController();
      loaded.controller = controller;
      loaded.turn = loaded.thread.runTurn(input, { signal: controller.signal }).catch((error: unknown) => {
        loaded.controller = null;
        if (!loaded.deleted) this.options.notify({ method: "warning", params: { threadId: params.threadId, message: `the turn stopped unexpectedly: ${(error as Error).message}` } });
      });
      this.options.notify({ method: "thread/updated", params: { thread: { ...(await this.info(loaded)), running: true } } });
      return {};
    },

    "turn/interrupt": async (params: ParamsOf<"turn/interrupt">): Promise<ResultOf<"turn/interrupt">> => {
      this.loaded(params.threadId).controller?.abort();
      return {};
    },

    "dialog/selectFolder": async (): Promise<ResultOf<"dialog/selectFolder">> => ({ path: (await this.options.selectFolder?.()) ?? null }),

    "shell/reveal": async (params: ParamsOf<"shell/reveal">): Promise<ResultOf<"shell/reveal">> => {
      this.options.reveal?.(params.path);
      return {};
    },
  };
}
