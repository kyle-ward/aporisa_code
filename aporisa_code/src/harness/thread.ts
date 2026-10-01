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
import { initialContext, permissionsItem } from "./context.ts";
import type { ThreadEvent, ThreadListener, TurnFailureCode, TurnOutcome } from "./events.ts";
import { estimatePromptTokens, estimateTokens, inputTokenLimit, normalizeHistory } from "./history.ts";
import { BASE_INSTRUCTIONS } from "./instructions.ts";
import { isAbsolute } from "./paths.ts";
import { permissionsMessage, resolveSafety, SessionRules, type SafetyOptions, type SafetyPolicy } from "./safety/index.ts";
import { HARNESS_VERSION, SessionStore, type SessionMeta } from "./store.ts";
import {
  defaultTools,
  ToolRegistry,
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

export type UserInput = string | readonly (InputTextPart | InputImagePart)[];

export interface ThreadOptions {
  /** One client per thread: a native client holds one WebSocket session (codex). */
  client: AporisaClient;
  host: Host;
  /** Absolute working directory. */
  cwd: string;
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
  private readonly registry: ToolRegistry;
  readonly safety: SafetyPolicy;
  private readonly rules = new SessionRules();
  private pendingPermissions: string | null;
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
    this.safety = resolved.safety;
    this.pendingPermissions = resolved.pendingPermissions;
    const escalation = resolved.safety.sandbox !== "danger-full-access" && resolved.safety.approval !== "never";
    this.registry = new ToolRegistry(defaultTools(resolved.model, { escalation }));
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
    const items = await initialContext(cwd, options.host.fs, info, now, permissionsMessage(safety));
    const meta: SessionMeta = {
      id,
      createdAt: now.toISOString(),
      cwd,
      model: model.id,
      driver: options.client.driver,
      effort,
      harnessVersion: HARNESS_VERSION,
      safety: safetySummary(safety),
    };
    const store = options.persist === false ? null : await SessionStore.create(options.host.fs, info.dataDir, meta, now);
    for (const item of items) store?.append({ type: "item", payload: { item } });
    const capabilities = await options.client.capabilities(model.id);
    const thread = new Thread({ client: options.client, host: options.host, model, capabilities, cwd, items, baseline: effort, store, id, safety, pendingPermissions: null }, options);
    thread.emit({ type: "thread.started", threadId: id, model: model.id, cwd, effort, resumed: false, sessionPath: thread.sessionPath, safety: safetySummary(safety) });
    thread.startPrewarm();
    return thread;
  }

  static async resume(options: ResumeOptions): Promise<Thread> {
    const info = options.host.info();
    const path = options.session.includes("/") ? options.session : await SessionStore.find(options.host.fs, info.dataDir, options.session);
    if (!path) throw new Error(`no session found for ${options.session}`);
    const loaded = await SessionStore.load(options.host.fs, path);
    const model = await options.client.getModel(loaded.meta.model);
    const capabilities = await options.client.capabilities(model.id);
    const store = options.persist === false ? null : SessionStore.open(options.host.fs, path);
    const items = normalizeHistory(loaded.items);
    const safety = await resolveSafety(options.safety ?? {}, loaded.meta.cwd, options.host.fs, info);
    // The opening permissions message describes the settings the thread started with; when
    // they differ now, the model is told at the end of the history (the prefix stays intact).
    const changed = JSON.stringify(loaded.meta.safety ?? null) !== JSON.stringify(safetySummary(safety));
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
      },
      options,
    );
    if (options.effort) thread.setEffort(options.effort);
    thread.emit({ type: "thread.started", threadId: thread.id, model: model.id, cwd: thread.cwd, effort: thread.effort, resumed: true, sessionPath: thread.sessionPath, safety: safetySummary(safety) });
    thread.startPrewarm();
    return thread;
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
      if (this.pendingPermissions !== null) {
        this.append(permissionsItem(this.pendingPermissions));
        this.pendingPermissions = null;
      }
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

  private append(item: InputItem, fullOutput?: string): void {
    this.history.push(item);
    this.store?.append({ type: "item", payload: { item, ...(fullOutput !== undefined ? { fullOutput } : {}) } });
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
      const params = this.params();
      const estimate = await this.estimateInputTokens(params);
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
    const produced: InputItem[] = [];
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
            this.emit({ type: "item.completed", turnId, item });
            if (item.type === "message") {
              result.lastMessage = messageText(item);
              // An empty message cannot be sent back (content needs a part); nothing to keep.
              if (item.content.length > 0) produced.push(item);
            } else {
              produced.push(item);
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
      for (const item of produced) this.append(item);
    }
    // Every started call gets its output into history, whatever happened to the response.
    for (const output of outputs) this.append(output.item, output.fullOutput);
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
      const fullOutput = result.fullOutput ?? (typeof result.output === "string" && output !== result.output ? result.output : undefined);
      return { item: { type: "function_call_output", call_id: call.call_id, output }, ...(fullOutput !== undefined ? { fullOutput } : {}) };
    });
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
