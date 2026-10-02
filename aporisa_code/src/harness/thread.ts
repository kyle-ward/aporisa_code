// Thread and turn loop (DEVELOPMENT_PLAN.md section 6), after codex's
// core/src/session/turn.rs: tool calls start as soon as their item is done, results go
// back in call order, and a response without tool calls ends the turn (protocol 7.3).
import type { Host, ProcessManager, ProcessManagerOptions } from "../host/index.ts";
import type {
  CapabilityName,
  InputImagePart,
  InputItem,
  InputTextPart,
  Model,
  OutputFunctionCallItem,
  ReasoningEffort,
  ResponseObject,
  ResponseParams,
} from "../protocol/index.ts";
import {
  AporisaAbortError,
  AporisaApiError,
  AporisaProtocolError,
  AporisaRequestError,
  AporisaTransportError,
  type AporisaClient,
  type Capabilities,
  type ResponseStream,
} from "../sdk/index.ts";
import { environmentUpdate, ENVIRONMENT_CONTEXT_TAG, initialContext, permissionsItem } from "./context.ts";
import type { ThreadEvent, ThreadListener, TurnFailureCode, TurnOutcome } from "./events.ts";
import { estimatePromptTokens, estimateTokens, inputTokenLimit, normalizeHistory } from "./history.ts";
import { BASE_INSTRUCTIONS, COMPACT_PROMPT, SUMMARY_PREFIX } from "./instructions.ts";
import { isAbsolute } from "./paths.ts";
import { permissionsMessage, resolveSafety, SessionRules, type SafetyOptions, type SafetyPolicy } from "./safety/index.ts";
import { defaultSessionsDir, HARNESS_VERSION, SessionStore, type ItemMeta, type SafetySummary, type SessionMeta } from "./store.ts";
import {
  approxTokenCount,
  defaultTools,
  ToolRegistry,
  truncateText,
  truncateToolOutput,
  withAllowance,
  type ApprovalDecision,
  type ApprovalRequest,
  type ToolContext,
  type ToolResult,
} from "./tools/index.ts";

export const DEFAULT_MAX_REQUESTS_PER_TURN = 200;
/** After asking the server to stop (WebSocket interrupt), close the connection if it has not. */
export const INTERRUPT_GRACE_MS = 5_000;
/** Consecutive `tool_call_invalid` failures that are re-sampled before the turn fails (FD-08). */
export const TOOL_CALL_INVALID_RETRIES = 1;
/** Recent user messages kept by compaction (codex COMPACT_USER_MESSAGE_MAX_TOKENS). */
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

/**
 * Input tokens at which a request first compacts the history (DEVELOPMENT_PLAN.md 10.5):
 * the model's auto_compact_token_limit (90% of the window when absent, codex's rule),
 * capped at 90% of what a request may carry so the compaction request itself still fits.
 */
export function autoCompactThreshold(model: Model, maxOutputTokens: number | undefined): number {
  const modelLimit = model.auto_compact_token_limit ?? Math.floor(model.context_window * 0.9);
  return Math.min(modelLimit, Math.floor(inputTokenLimit(model, maxOutputTokens) * 0.9));
}

export type UserInput = string | readonly (InputTextPart | InputImagePart)[];

export interface ThreadOptions {
  /** One client per thread: a native client holds one WebSocket session (codex). */
  client: AporisaClient;
  host: Host;
  /** Absolute working directory: the only folder the thread writes to without asking. */
  cwd: string;
  /**
   * Reference directories (F4.5): absolute folders the model may read for reference. They are
   * listed in the environment context as read-only; beyond that they are like any path outside
   * cwd (writing needs approval, FD-25). On resume: the directories wanted now; a difference
   * from the record is told to the model at the next turn.
   */
  references?: string[];
  /** Stored in the session record for the owning app (F4.5); the harness never reads it. */
  projectId?: string | null;
  /** Public model alias; default the first model the server lists. */
  model?: string;
  /** Reasoning effort; default the model's default. On resume it acts like setEffort(). */
  effort?: ReasoningEffort;
  /** Sandbox and approval policy (F3); defaults per DEVELOPMENT_PLAN.md section 9. */
  safety?: SafetyOptions;
  /** Answers approval questions. Absent: anything that needs approval is refused. */
  approve?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Write the session record (default true). */
  persist?: boolean;
  /** Prefill the fixed context when the thread starts (default true when supported). */
  prewarm?: boolean;
  maxRequestsPerTurn?: number;
  /** Request `max_output_tokens`; default the model's limit. */
  maxOutputTokens?: number;
  instructions?: string;
  processes?: ProcessManagerOptions;
  /** Subscribed before `thread.started` is emitted. */
  listener?: ThreadListener;
  /** Where session files go; default <dataDir>/profiles/local/sessions (FD-22). */
  sessionsDir?: string;
  /** Compact the history automatically near the context limit (default true; F4 baseline). */
  autoCompact?: boolean;
  now?: () => Date;
}

export interface ResumeOptions extends Omit<ThreadOptions, "cwd" | "model"> {
  /** Thread id or session file path. */
  session: string;
}

export interface TurnOptions {
  signal?: AbortSignal;
}

interface SampleResult {
  response: ResponseObject | null;
  error: { code: TurnFailureCode | string; message: string } | null;
  interrupted: boolean;
  calls: number;
  lastMessage: string | null;
}

export interface CompactionResult {
  compacted: boolean;
  /** Estimated input tokens before and after. */
  before: number;
  after: number;
  error?: string;
}

interface Resolved {
  client: AporisaClient;
  host: Host;
  model: Model;
  capabilities: Capabilities;
  cwd: string;
  items: InputItem[];
  baseline: ReasoningEffort;
  store: SessionStore | null;
  id: string;
  safety: SafetyPolicy;
  /** A permissions message to append before the next user message (resume with new settings). */
  pendingPermissions: string | null;
  initialItemCount: number;
  references: string[];
  /** What the opening items say: compaction keeps them, so later changes are told again. */
  openingReferences: string[];
  openingSafety: SafetySummary | null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Real paths of existing directories, without cwd and duplicates. `strict` throws on a
 * missing or invalid one (thread start); otherwise it is dropped (a folder removed later).
 */
async function resolveReferences(fs: Host["fs"], cwd: string, paths: readonly string[], strict: boolean): Promise<{ references: string[]; dropped: string[] }> {
  const references: string[] = [];
  const dropped: string[] = [];
  for (const path of paths) {
    try {
      if (!isAbsolute(path)) throw new Error(`reference directory must be absolute: ${path}`);
      const real = await fs.realpath(path);
      if ((await fs.stat(real))?.kind !== "directory") throw new Error(`reference directory is not a directory: ${path}`);
      if (real !== cwd && !references.includes(real)) references.push(real);
    } catch (error) {
      if (strict) throw error instanceof Error && error.message.startsWith("reference directory") ? error : new Error(`reference directory not found: ${path}`);
      dropped.push(path);
    }
  }
  return { references, dropped };
}

/** Read-write lock in arrival order: parallel tools share it, the others run alone (codex parallel.rs). */
class ToolScheduler {
  private barrier: Promise<unknown> = Promise.resolve();
  private running: Promise<unknown>[] = [];

  schedule<T>(parallel: boolean, task: () => Promise<T>): Promise<T> {
    if (parallel) {
      const promise = this.barrier.then(task);
      this.running.push(promise.catch(() => undefined));
      return promise;
    }
    const promise = Promise.all([this.barrier, ...this.running]).then(task);
    this.barrier = promise.catch(() => undefined);
    this.running = [];
    return promise;
  }
}

function userMessage(input: UserInput): InputItem {
  const content = typeof input === "string" ? [{ type: "input_text" as const, text: input }] : [...input];
  if (content.length === 0) throw new Error("user input must not be empty");
  return { type: "message", role: "user", content };
}

function messageText(item: { content: readonly { text: string }[] }): string {
  return item.content.map((part) => part.text).join("");
}

function failureOf(error: unknown): { code: string; message: string } | null {
  if (error instanceof AporisaApiError || error instanceof AporisaRequestError) return { code: error.code, message: error.message };
  if (error instanceof AporisaTransportError) return { code: "transport_error", message: error.message };
  if (error instanceof AporisaProtocolError) return { code: "protocol_error", message: error.message };
  return null;
}

/** The settings recorded in the session (and compared on resume). */
export function safetySummary(policy: SafetyPolicy): { sandbox: string; approval: string; network: boolean } {
  return { sandbox: policy.sandbox, approval: policy.approval, network: policy.network };
}

function lastEffortUpdate(items: readonly InputItem[]): ReasoningEffort | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "configuration_update") return item.reasoning.effort;
  }
  return null;
}

export class Thread {
  readonly id: string;
  readonly model: Model;
  readonly cwd: string;
  readonly sessionPath: string | null;
  private readonly client: AporisaClient;
  private readonly host: Host;
  private readonly capabilities: Capabilities;
  private registry: ToolRegistry;
  private policy: SafetyPolicy;
  private pendingSafety: SafetyOptions | null = null;
  private pendingReferences: string[] | null = null;
  private currentReferences: string[];
  private readonly openingReferences: string[];
  private readonly openingSafety: SafetySummary | null;
  private readonly rules = new SessionRules();
  private pendingPermissions: string | null;
  private readonly initialItemCount: number;
  private readonly processes: ProcessManager;
  private readonly store: SessionStore | null;
  private readonly instructions: string;
  private readonly options: ThreadOptions | ResumeOptions;
  private readonly listeners = new Set<ThreadListener>();
  private readonly history: InputItem[];
  private baseline: ReasoningEffort;
  private effective: ReasoningEffort;
  private pendingEffort: ReasoningEffort | null = null;
  private usageMark: { tokens: number; itemCount: number } | null = null;
  private prewarming: Promise<void> = Promise.resolve();
  private approvals: Promise<unknown> = Promise.resolve();
  private running = false;
  private closed = false;

  private constructor(resolved: Resolved, options: ThreadOptions | ResumeOptions) {
    this.id = resolved.id;
    this.client = resolved.client;
    this.host = resolved.host;
    this.model = resolved.model;
    this.capabilities = resolved.capabilities;
    this.cwd = resolved.cwd;
    this.history = resolved.items;
    this.baseline = resolved.baseline;
    this.effective = lastEffortUpdate(resolved.items) ?? resolved.baseline;
    this.store = resolved.store;
    this.sessionPath = resolved.store?.path ?? null;
    this.options = options;
    this.instructions = options.instructions ?? BASE_INSTRUCTIONS;
    this.policy = resolved.safety;
    this.pendingPermissions = resolved.pendingPermissions;
    this.initialItemCount = resolved.initialItemCount;
    this.currentReferences = resolved.references;
    this.openingReferences = resolved.openingReferences;
    this.openingSafety = resolved.openingSafety;
    this.registry = Thread.registryFor(resolved.model, resolved.safety);
    this.processes = resolved.host.openProcessManager(options.processes);
    if (options.listener) this.listeners.add(options.listener);
  }

  static async start(options: ThreadOptions): Promise<Thread> {
    if (!isAbsolute(options.cwd)) throw new Error(`cwd must be absolute: ${options.cwd}`);
    const cwd = await options.host.fs.realpath(options.cwd);
    if ((await options.host.fs.stat(cwd))?.kind !== "directory") throw new Error(`cwd is not a directory: ${options.cwd}`);
    const model = options.model ? await options.client.getModel(options.model) : (await options.client.listModels())[0];
    if (!model) throw new Error("the server lists no models");
    const effort = options.effort ?? model.reasoning.default_effort;
    if (!model.reasoning.supported_efforts.includes(effort)) throw new Error(`effort '${effort}' is not supported by ${model.id}`);
    const now = (options.now ?? (() => new Date()))();
    const id = crypto.randomUUID();
    const info = options.host.info();
    const safety = await resolveSafety(options.safety ?? {}, cwd, options.host.fs, info);
    const { references } = await resolveReferences(options.host.fs, cwd, options.references ?? [], true);
    const items = await initialContext(cwd, options.host.fs, info, now, permissionsMessage(safety), references);
    const meta: SessionMeta = {
      initialItemCount: items.length,
      id,
      createdAt: now.toISOString(),
      cwd,
      model: model.id,
      driver: options.client.driver,
      effort,
      harnessVersion: HARNESS_VERSION,
      safety: safetySummary(safety),
      ...(references.length > 0 ? { references } : {}),
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    };
    const sessionsDir = options.sessionsDir ?? defaultSessionsDir(info.dataDir);
    const store = options.persist === false ? null : await SessionStore.create(options.host.fs, sessionsDir, meta, now);
    for (const item of items) store?.append({ type: "item", payload: { item } });
    const capabilities = await options.client.capabilities(model.id);
    const thread = new Thread(
      {
        client: options.client,
        host: options.host,
        model,
        capabilities,
        cwd,
        items,
        baseline: effort,
        store,
        id,
        safety,
        pendingPermissions: null,
        initialItemCount: items.length,
        references,
        openingReferences: references,
        openingSafety: safetySummary(safety),
      },
      options,
    );
    thread.emit({ type: "thread.started", threadId: id, model: model.id, cwd, effort, resumed: false, sessionPath: thread.sessionPath, safety: safetySummary(safety) });
    thread.startPrewarm();
    return thread;
  }

  static async resume(options: ResumeOptions): Promise<Thread> {
    const info = options.host.info();
    const sessionsDir = options.sessionsDir ?? defaultSessionsDir(info.dataDir);
    const path = options.session.includes("/") ? options.session : await SessionStore.find(options.host.fs, sessionsDir, options.session);
    if (!path) throw new Error(`no session found for ${options.session}`);
    const loaded = await SessionStore.load(options.host.fs, path);
    const model = await options.client.getModel(loaded.meta.model);
    const capabilities = await options.client.capabilities(model.id);
    const store = options.persist === false ? null : SessionStore.open(options.host.fs, path);
    const items = normalizeHistory(loaded.items);
    const safety = await resolveSafety(options.safety ?? {}, loaded.meta.cwd, options.host.fs, info);
    // The opening permissions message describes the settings the thread started with; when
    // they differ now, the model is told at the end of the history (the prefix stays intact).
    const changed = JSON.stringify(loaded.safety) !== JSON.stringify(safetySummary(safety));
    const thread = new Thread(
      {
        client: options.client,
        host: options.host,
        model,
        capabilities,
        cwd: loaded.meta.cwd,
        items: [...items],
        baseline: loaded.baseline,
        store,
        id: loaded.meta.id,
        safety,
        pendingPermissions: changed ? permissionsMessage(safety) : null,
        initialItemCount: Math.min(loaded.initialItemCount, items.length),
        references: loaded.references,
        openingReferences: loaded.meta.references ?? [],
        openingSafety: loaded.meta.safety ?? null,
      },
      options,
    );
    if (options.effort) thread.setEffort(options.effort);
    if (options.references !== undefined) thread.setReferences(options.references);
    thread.emit({ type: "thread.started", threadId: thread.id, model: model.id, cwd: thread.cwd, effort: thread.effort, resumed: true, sessionPath: thread.sessionPath, safety: safetySummary(safety) });
    thread.startPrewarm();
    return thread;
  }

  /** The safety policy in force (a pending change applies at the next turn). */
  get safety(): SafetyPolicy {
    return this.policy;
  }

  /** True while a turn (or a manual compaction) runs. */
  get busy(): boolean {
    return this.running;
  }

  /**
   * Changes sandbox, approval or network settings from the next turn on. The model is told
   * with a permissions message at the end of the history; changing whether escalation is
   * offered changes the tool specs, which costs the prefix cache once.
   */
  setSafety(options: SafetyOptions): void {
    this.pendingSafety = { ...this.pendingSafety, ...options };
  }

  /** The reference directories in force (a pending change applies at the next turn). */
  get references(): readonly string[] {
    return this.currentReferences;
  }

  /**
   * Changes the reference directories from the next turn on (F4.5). The model is told with an
   * environment update at the end of the history; nothing changes when the set is the same.
   */
  setReferences(paths: readonly string[]): void {
    this.pendingReferences = [...paths];
  }

  /** Compacts the history now (between turns). */
  async compact(): Promise<CompactionResult> {
    if (this.closed) throw new Error("the thread is closed");
    if (this.running) throw new Error("a turn is already running in this thread");
    this.running = true;
    try {
      await this.prewarming;
      return await this.compactHistory("manual", null, new AbortController().signal);
    } finally {
      await this.flushStore();
      this.running = false;
    }
  }

  /** Estimated input tokens of the next request (for a context meter). */
  async contextTokens(): Promise<number> {
    return this.estimateInputTokens(this.params());
  }

  /** The history the next request will send. */
  get items(): readonly InputItem[] {
    return this.history;
  }

  /** The effort in force for the next request (after a pending change). */
  get effort(): ReasoningEffort {
    return this.pendingEffort ?? this.effective;
  }

  subscribe(listener: ThreadListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Takes effect at the next turn (protocol 6.1: appended before the next user message). */
  setEffort(effort: ReasoningEffort): void {
    if (!this.model.reasoning.supported_efforts.includes(effort)) throw new Error(`effort '${effort}' is not supported by ${this.model.id}`);
    this.pendingEffort = effort;
  }

  async runTurn(input: UserInput, options: TurnOptions = {}): Promise<TurnOutcome> {
    if (this.closed) throw new Error("the thread is closed");
    if (this.running) throw new Error("a turn is already running in this thread");
    this.running = true;
    const turnId = crypto.randomUUID();
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", forward, { once: true });
    try {
      await this.prewarming;
      this.emit({ type: "turn.started", turnId });
      this.store?.append({ type: "turn", payload: { turnId, event: "started" } });
      this.applyPendingEffort(turnId);
      await this.applyPendingSafety(turnId);
      if (this.pendingPermissions !== null) {
        this.append(permissionsItem(this.pendingPermissions));
        this.pendingPermissions = null;
      }
      await this.applyPendingReferences(turnId);
      this.append(userMessage(input));
      const outcome = await this.loop(turnId, controller.signal);
      if (outcome.status === "interrupted") await this.processes.terminateAll();
      this.store?.append({ type: "turn", payload: { turnId, event: "completed", outcome } });
      this.emit({ type: "turn.completed", turnId, outcome });
      return outcome;
    } finally {
      options.signal?.removeEventListener("abort", forward);
      const fixed = normalizeHistory(this.history);
      if (fixed !== this.history) this.history.splice(0, this.history.length, ...fixed);
      await this.flushStore(turnId);
      this.running = false;
    }
  }

  /** Stops every process of this thread and finishes writing the session record. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.prewarming;
    await this.processes.terminateAll();
    await this.flushStore();
  }

  // --- internals -------------------------------------------------------------------

  private supports(name: CapabilityName): boolean {
    return this.capabilities[name] !== "unsupported";
  }

  private emit(event: ThreadEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failing consumer must not break the turn.
      }
    }
  }

  private async flushStore(turnId?: string): Promise<void> {
    try {
      await this.store?.flush();
    } catch (error) {
      const message = `could not write the session record: ${(error as Error).message}`;
      this.emit({ type: "warning", ...(turnId ? { turnId } : {}), message });
    }
  }

  private append(item: InputItem, meta: ItemMeta = {}): void {
    this.history.push(item);
    this.store?.append({ type: "item", payload: { item, ...meta } });
  }

  private static registryFor(model: Model, policy: SafetyPolicy): ToolRegistry {
    const escalation = policy.sandbox !== "danger-full-access" && policy.approval !== "never";
    return new ToolRegistry(defaultTools(model, { escalation }));
  }

  private async applyPendingSafety(turnId: string): Promise<void> {
    const pending = this.pendingSafety;
    this.pendingSafety = null;
    if (pending === null) return;
    const current: SafetyOptions = {
      sandbox: this.policy.sandbox,
      approval: this.policy.approval,
      network: this.policy.network,
      stripSecrets: this.policy.stripSecrets,
    };
    const next = await resolveSafety({ ...current, ...pending }, this.cwd, this.host.fs, this.host.info());
    if (JSON.stringify(safetySummary(next)) === JSON.stringify(safetySummary(this.policy))) return;
    this.policy = next;
    this.registry = Thread.registryFor(this.model, next);
    this.pendingPermissions = permissionsMessage(next);
    this.store?.append({ type: "safety", payload: safetySummary(next) });
    this.emit({ type: "safety.changed", turnId, safety: safetySummary(next) });
  }

  private async applyPendingReferences(turnId: string): Promise<void> {
    const pending = this.pendingReferences;
    this.pendingReferences = null;
    if (pending === null) return;
    const { references, dropped } = await resolveReferences(this.host.fs, this.cwd, pending, false);
    for (const path of dropped) this.emit({ type: "warning", turnId, message: `reference directory not found, left out: ${path}` });
    if (sameList(references, this.currentReferences)) return;
    this.currentReferences = references;
    this.append(environmentUpdate(this.cwd, references));
    this.store?.append({ type: "context", payload: { references } });
    this.emit({ type: "context.changed", turnId, references });
  }

  private params(): ResponseParams {
    return {
      model: this.model.id,
      instructions: this.instructions,
      input: [...this.history],
      tools: this.registry.specs(),
      ...(this.supports("parallel_tool_calls") ? { parallel_tool_calls: true } : {}),
      reasoning: { effort: this.baseline },
      ...(this.options.maxOutputTokens !== undefined ? { max_output_tokens: this.options.maxOutputTokens } : {}),
      prompt_cache_key: this.id,
    };
  }

  private startPrewarm(): void {
    if (this.options.prewarm === false || !this.supports("prewarm")) return;
    const stream = this.client.createResponse({ ...this.params(), generate: false });
    this.prewarming = stream.final().then(
      () => undefined,
      (error: unknown) => this.emit({ type: "warning", message: `prewarm failed: ${(error as Error).message}` }),
    );
  }

  private applyPendingEffort(turnId: string): void {
    const effort = this.pendingEffort;
    this.pendingEffort = null;
    if (effort === null || effort === this.effective) return;
    if (this.supports("reasoning_effort_updates")) {
      this.append({ type: "configuration_update", reasoning: { effort } });
      this.emit({ type: "effort.changed", turnId, effort, via: "configuration_update" });
    } else {
      // Without configuration_update the request field changes: the prefix cache is lost.
      this.baseline = effort;
      this.store?.append({ type: "baseline", payload: { effort } });
      this.emit({ type: "effort.changed", turnId, effort, via: "baseline" });
    }
    this.effective = effort;
  }

  private async estimateInputTokens(params: ResponseParams): Promise<number> {
    if (this.usageMark) return this.usageMark.tokens + estimateTokens(this.history.slice(this.usageMark.itemCount));
    if (this.supports("input_tokens")) {
      try {
        return (await this.client.countInputTokens(params)).input_tokens;
      } catch {
        // Fall back to the byte estimate.
      }
    }
    return estimatePromptTokens(params.instructions ?? "", params.tools ?? [], params.input);
  }

  private async loop(turnId: string, signal: AbortSignal): Promise<TurnOutcome> {
    const maxRequests = this.options.maxRequestsPerTurn ?? DEFAULT_MAX_REQUESTS_PER_TURN;
    const limit = inputTokenLimit(this.model, this.options.maxOutputTokens);
    const outcome: TurnOutcome = {
      status: "completed",
      requests: 0,
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      lastMessage: null,
    };
    const fail = (code: string, message: string): TurnOutcome => ({ ...outcome, status: "failed", error: { code, message } });
    let invalidRetries = 0;

    for (;;) {
      if (signal.aborted) return { ...outcome, status: "interrupted" };
      if (outcome.requests >= maxRequests) return fail("max_requests", `the turn reached ${maxRequests} model requests`);
      let params = this.params();
      let estimate = await this.estimateInputTokens(params);
      if (this.options.autoCompact !== false && estimate >= autoCompactThreshold(this.model, this.options.maxOutputTokens) && this.history.length > this.initialItemCount + 1) {
        const result = await this.compactHistory("auto", turnId, signal);
        if (signal.aborted) return { ...outcome, status: "interrupted" };
        if (result.compacted) {
          params = this.params();
          estimate = await this.estimateInputTokens(params);
        }
      }
      if (estimate > limit) {
        return fail("context_window_exceeded", `the conversation needs about ${estimate} input tokens; the model accepts ${limit} with the reserved output`);
      }
      outcome.requests += 1;
      const sample = await this.sample(turnId, outcome.requests, params, signal);
      const usage = sample.response?.usage;
      if (usage) {
        outcome.usage.inputTokens += usage.input_tokens;
        outcome.usage.cachedTokens += usage.input_tokens_details.cached_tokens;
        outcome.usage.outputTokens += usage.output_tokens;
        outcome.usage.reasoningTokens += usage.output_tokens_details.reasoning_tokens;
      }
      if (sample.lastMessage !== null) outcome.lastMessage = sample.lastMessage;
      if (sample.interrupted || signal.aborted) return { ...outcome, status: "interrupted" };
      if (sample.error) {
        if (sample.error.code === "tool_call_invalid" && invalidRetries < TOOL_CALL_INVALID_RETRIES) {
          invalidRetries += 1;
          this.emit({ type: "warning", turnId, message: "the model produced a malformed tool call; requesting again" });
          continue;
        }
        return fail(sample.error.code, sample.error.message);
      }
      invalidRetries = 0;
      if (sample.calls > 0) continue;
      if (sample.response?.incomplete_details?.reason === "max_output_tokens") outcome.truncated = true;
      return outcome;
    }
  }

  private async sample(turnId: string, requestIndex: number, params: ResponseParams, signal: AbortSignal): Promise<SampleResult> {
    const started = performance.now();
    let firstOutput: number | null = null;
    const connection = new AbortController();
    let hardStop: ReturnType<typeof setTimeout> | null = null;
    let stream: ResponseStream | null = null;
    const onAbort = () => {
      if (stream?.interrupt()) hardStop = setTimeout(() => connection.abort(), INTERRUPT_GRACE_MS);
      else connection.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const scheduler = new ToolScheduler();
    const toolOutputs: Promise<{ item: InputItem; fullOutput?: string }>[] = [];
    // Output items are committed when the response ends (FD-08 may discard them).
    const produced: { item: InputItem; durationMs: number | undefined }[] = [];
    const itemStarted = new Map<string, number>();
    let unexpected: { error: unknown } | null = null;
    const result: SampleResult = { response: null, error: null, interrupted: false, calls: 0, lastMessage: null };
    try {
      stream = this.client.createResponse(params, { signal: connection.signal });
      if (signal.aborted) onAbort();
      for await (const event of stream) {
        switch (event.type) {
          case "response.output_item.added":
            // Close to time to first token: the server opens the first item with its first token.
            firstOutput ??= performance.now() - started;
            itemStarted.set(event.item.id, performance.now());
            this.emit({
              type: "item.started",
              turnId,
              itemId: event.item.id,
              kind: event.item.type,
              ...(event.item.type === "function_call" || event.item.type === "custom_tool_call" ? { name: event.item.name } : {}),
            });
            break;
          case "response.output_text.delta":
            this.emit({ type: "item.delta", turnId, itemId: event.item_id, kind: "text", delta: event.delta });
            break;
          case "response.reasoning_text.delta":
          case "response.reasoning_summary_text.delta":
            this.emit({ type: "item.delta", turnId, itemId: event.item_id, kind: "reasoning", delta: event.delta });
            break;
          case "response.function_call_arguments.delta":
          case "response.custom_tool_call_input.delta":
            this.emit({ type: "item.delta", turnId, itemId: event.item_id, kind: "arguments", delta: event.delta });
            break;
          case "response.output_item.done": {
            const item = event.item;
            const opened = itemStarted.get(item.id);
            const durationMs = opened === undefined ? undefined : Math.round(performance.now() - opened);
            this.emit({ type: "item.completed", turnId, item, ...(durationMs !== undefined ? { durationMs } : {}) });
            if (item.type === "message") {
              result.lastMessage = messageText(item);
              // An empty message cannot be sent back (content needs a part); nothing to keep.
              if (item.content.length > 0) produced.push({ item, durationMs });
            } else {
              produced.push({ item, durationMs });
            }
            if (item.type === "function_call") {
              result.calls += 1;
              const parallel = this.registry.supportsParallel(item.name);
              toolOutputs.push(this.registerCall(turnId, item, signal, scheduler, parallel));
            } else if (item.type === "custom_tool_call") {
              result.calls += 1;
              toolOutputs.push(Promise.resolve({ item: { type: "custom_tool_call_output", call_id: item.call_id, output: `Unknown tool '${item.name}'.` } }));
            }
            break;
          }
          default:
            break;
        }
      }
      result.response = await stream.final();
    } catch (error) {
      if (error instanceof AporisaAbortError || signal.aborted) {
        result.interrupted = true;
      } else {
        const failure = failureOf(error);
        if (failure) result.error = failure;
        else unexpected = { error };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (hardStop) clearTimeout(hardStop);
    }

    const outputs = await Promise.all(toolOutputs);
    const response = result.response;
    if (response?.status === "failed" && response.error) result.error = { code: response.error.code, message: response.error.message };
    if (response?.incomplete_details?.reason === "interrupted") result.interrupted = true;
    // FD-08: a malformed tool call before any call completed leaves only reasoning or
    // commentary. Dropping it resends the identical request; keeping it would leave an
    // assistant turn without tool calls that the next response's items would merge into,
    // changing how the history renders and losing the prefix cache from there.
    if (result.error?.code === "tool_call_invalid" && result.calls === 0) {
      result.lastMessage = null;
    } else {
      for (const { item, durationMs } of produced) this.append(item, { turnId, ...(durationMs !== undefined ? { durationMs } : {}) });
    }
    // Every started call gets its output into history, whatever happened to the response.
    for (const output of outputs) this.append(output.item, { turnId, ...(output.fullOutput !== undefined ? { fullOutput: output.fullOutput } : {}) });
    if (response?.usage) this.usageMark = { tokens: response.usage.input_tokens + response.usage.output_tokens, itemCount: this.history.length - outputs.length };
    const status = response?.status === "completed" || response?.status === "incomplete" ? response.status : "failed";
    const durationMs = performance.now() - started;
    this.emit({ type: "response.completed", turnId, requestIndex, status, usage: response?.usage ?? null, timeToFirstOutputMs: firstOutput, durationMs });
    this.store?.append({
      type: "usage",
      payload: { turnId, requestIndex, status, usage: response?.usage ?? null, timeToFirstOutputMs: firstOutput, durationMs, ...(result.error ? { error: result.error } : {}) },
    });
    if (unexpected) throw unexpected.error;
    return result;
  }

  private registerCall(
    turnId: string,
    call: OutputFunctionCallItem,
    signal: AbortSignal,
    scheduler: ToolScheduler,
    parallel: boolean,
  ): Promise<{ item: InputItem; fullOutput?: string }> {
    return scheduler.schedule(parallel, async () => {
      this.emit({ type: "tool.started", turnId, callId: call.call_id, name: call.name, arguments: call.arguments });
      let result: ToolResult;
      if (signal.aborted) {
        result = { output: "The user interrupted the turn before this tool call ran.", success: false };
      } else {
        const context: ToolContext = {
          host: this.host,
          cwd: this.cwd,
          processes: this.processes,
          truncation: this.model.truncation_policy,
          signal,
          safety: { policy: this.safety, rules: this.rules },
          ...(this.options.approve ? { approve: (request: ApprovalRequest) => this.requestApproval(turnId, call.call_id, request, signal) } : {}),
        };
        try {
          result = await this.registry.dispatch({ name: call.name, arguments: call.arguments }, context);
        } catch (error) {
          this.emit({ type: "warning", turnId, message: `tool ${call.name} failed unexpectedly: ${(error as Error).message}` });
          result = { output: `The tool failed unexpectedly: ${(error as Error).message}`, success: false };
        }
        const unfinished = (result.details?.kind === "command" || result.details?.kind === "stdin") && result.details.exitCode === null;
        if (signal.aborted && unfinished) {
          result = { ...result, output: "The command was interrupted by the user before it finished.", success: false };
        }
      }
      const output = truncateToolOutput(result.output, withAllowance(this.model.truncation_policy));
      this.emit({
        type: "tool.completed",
        turnId,
        callId: call.call_id,
        name: call.name,
        success: result.success,
        output,
        ...(result.details ? { details: result.details } : {}),
      });
      this.store?.append({
        type: "tool",
        payload: { turnId, callId: call.call_id, name: call.name, arguments: call.arguments, success: result.success, ...(result.details ? { details: result.details } : {}) },
      });
      const fullOutput = result.fullOutput ?? (typeof result.output === "string" && output !== result.output ? result.output : undefined);
      return { item: { type: "function_call_output", call_id: call.call_id, output }, ...(fullOutput !== undefined ? { fullOutput } : {}) };
    });
  }

  /**
   * The F4 baseline compaction (DEVELOPMENT_PLAN.md 10.5, after codex core/src/compact.rs):
   * ask the model for a handoff summary of the history, then start the history over with
   * the opening items, the most recent user messages (up to 20K tokens) and the summary.
   * The prefix cache is lost from the start: the next request prefills everything again.
   */
  private async compactHistory(reason: "auto" | "manual", turnId: string | null, signal: AbortSignal): Promise<CompactionResult> {
    const before = await this.estimateInputTokens(this.params());
    this.emit({ type: "compaction.started", turnId, reason, tokens: before });
    const request: ResponseParams = {
      ...this.params(),
      input: [...this.history, { type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] }],
      tool_choice: "none",
    };
    let summary = "";
    try {
      const response = await this.client.createResponse(request, { signal }).final();
      if (response.status !== "completed") throw new Error(response.error?.message ?? `the summary ended as ${response.status}`);
      for (const item of response.output) if (item.type === "message") summary = messageText(item);
      if (summary.trim() === "") throw new Error("the model returned no summary");
    } catch (error) {
      const message = signal.aborted ? "interrupted" : (error as Error).message;
      this.emit({ type: "compaction.completed", turnId, reason, compacted: false, tokensBefore: before, tokensAfter: before, error: message });
      if (!signal.aborted) this.emit({ type: "warning", ...(turnId ? { turnId } : {}), message: `context compaction failed: ${message}` });
      return { compacted: false, before, after: before, error: message };
    }

    const opening = this.history.slice(0, this.initialItemCount);
    const recent: InputItem[] = [];
    let remaining = COMPACT_USER_MESSAGE_MAX_TOKENS;
    for (let index = this.history.length - 1; index >= this.initialItemCount && remaining > 0; index -= 1) {
      const item = this.history[index];
      if (item?.type !== "message" || item.role !== "user") continue;
      const text = item.content.map((part) => (part.type === "input_image" ? "[image]" : part.text)).join("\n");
      if (text.startsWith(SUMMARY_PREFIX)) continue; // an earlier summary is superseded by the new one
      if (text.startsWith(ENVIRONMENT_CONTEXT_TAG)) continue; // restated below when still different
      const tokens = approxTokenCount(text);
      const kept = tokens <= remaining ? text : truncateText(text, { mode: "tokens", limit: remaining });
      recent.unshift({ type: "message", role: "user", content: [{ type: "input_text", text: kept }] });
      remaining -= Math.min(tokens, remaining);
    }
    // Mid-thread changes were told after the opening items, which compaction drops: restate
    // the settings that differ from what the opening items say.
    const restated: InputItem[] = [];
    if (JSON.stringify(this.openingSafety) !== JSON.stringify(safetySummary(this.policy))) restated.push(permissionsItem(permissionsMessage(this.policy)));
    if (!sameList(this.openingReferences, this.currentReferences)) restated.push(environmentUpdate(this.cwd, this.currentReferences));
    const next: InputItem[] = [...opening, ...restated, ...recent, { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] }];
    this.history.splice(0, this.history.length, ...next);
    // A new context window: the effort in force becomes the baseline (protocol 6.1).
    this.baseline = this.effective;
    this.usageMark = null;
    this.store?.append({ type: "compacted", payload: { items: next, reason, baseline: this.baseline, ...(turnId ? { turnId } : {}) } });
    const after = estimatePromptTokens(this.instructions, this.registry.specs(), this.history);
    this.emit({ type: "compaction.completed", turnId, reason, compacted: true, tokensBefore: before, tokensAfter: after });
    return { compacted: true, before, after };
  }

  /** One question at a time, in call order, even when tools run in parallel. */
  private requestApproval(turnId: string, callId: string, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const approve = this.options.approve;
    const next = this.approvals.then(async (): Promise<ApprovalDecision> => {
      if (!approve || signal.aborted) return "denied";
      this.emit({ type: "approval.requested", turnId, callId, request });
      let decision: ApprovalDecision = "denied";
      let onAbort: (() => void) | null = null;
      const cancelled = new Promise<ApprovalDecision>((resolve) => {
        onAbort = () => resolve("denied");
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        // A turn cancelled while the user is being asked counts as a refusal.
        decision = await Promise.race([approve(request), cancelled]);
      } catch {
        decision = "denied";
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      const approved = decision !== "denied";
      this.emit({ type: "approval.resolved", turnId, callId, approved, decision });
      this.store?.append({ type: "approval", payload: { turnId, callId, kind: request.kind, reason: request.reason, decision } });
      return decision;
    });
    this.approvals = next.catch(() => "denied");
    return next;
  }
}
