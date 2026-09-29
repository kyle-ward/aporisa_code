// Deterministic, scriptable generation engine: the executable form of the contract.
// Shared by the mock server (wire level) and the stub driver (in-process).
import {
  canonicalJson,
  StreamValidator,
  type EventWithoutSequence,
  type InputItem,
  type MessagePhase,
  type Model,
  type OutputItem,
  type ResponseObject,
  type ResponseParams,
  type StreamErrorCode,
  type StreamEvent,
  type Usage,
} from "../protocol/index.ts";

export type MockStep =
  | { type: "message"; text: string; phase?: MessagePhase }
  | { type: "reasoning"; text: string; summary?: string }
  | { type: "function_call"; name: string; arguments: string }
  | { type: "custom_tool_call"; name: string; input: string };

export interface MockPlan {
  steps: MockStep[];
  /** Emit response.failed once this many steps have completed. */
  failAfter?: { steps: number; code: StreamErrorCode; message: string };
}

export interface MockScriptContext {
  params: ResponseParams;
  requestIndex: number;
}

export type MockScript = (context: MockScriptContext) => MockPlan;

export function lastUserText(input: readonly InputItem[]): string {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (item?.type === "message" && item.role === "user") {
      return item.content.map((part) => (part.type === "input_text" ? part.text : "")).join("");
    }
  }
  return "";
}

/** Default behaviour: answer with an echo of the last user text. */
export const echoScript: MockScript = ({ params }) => ({
  steps: [{ type: "message", text: `echo: ${lastUserText(params.input)}`, phase: "final_answer" }],
});

export function tokensOf(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export class IdGenerator {
  private counter = 0;
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(6, "0")}`;
  }
}

export interface MockEngineOptions {
  model: Model;
  script?: MockScript;
  /** Characters per delta event. */
  chunkSize?: number;
  /** Delay before each delta; lets tests interrupt or cancel mid-stream. */
  chunkDelayMs?: number;
  ids?: IdGenerator;
  now?: () => number;
}

export interface RunControl {
  /** Hard cancellation (client disconnected): stop without a terminal event. */
  signal?: AbortSignal;
  /** Graceful interrupt requested (WebSocket response.interrupt). */
  interrupted?: () => boolean;
  /** Called with the response id as soon as it is known. */
  onResponseId?: (id: string) => void;
}

/** Segment list used for prefix-cache accounting (extension X1). */
function segmentsOf(params: ResponseParams): string[] {
  return [
    canonicalJson({ instructions: params.instructions ?? "" }),
    canonicalJson({ tools: params.tools ?? [] }),
    ...params.input.map((item) => canonicalJson({ ...item, id: undefined })),
  ];
}

export class MockEngine {
  readonly model: Model;
  script: MockScript;
  chunkSize: number;
  chunkDelayMs: number;
  private readonly ids: IdGenerator;
  private readonly now: () => number;
  private readonly cache = new Map<string, string[]>();
  private requestIndex = 0;

  constructor(options: MockEngineOptions) {
    this.model = options.model;
    this.script = options.script ?? echoScript;
    this.chunkSize = options.chunkSize ?? 8;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.ids = options.ids ?? new IdGenerator();
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  inputTokens(params: ResponseParams): number {
    return segmentsOf(params).reduce((sum, segment) => sum + tokensOf(segment), 0);
  }

  /** Context admission check (§9.1 context_length_exceeded), done before generating. */
  exceedsContext(params: ResponseParams): boolean {
    const reserved = params.max_output_tokens ?? this.model.max_output_tokens;
    return this.inputTokens(params) + reserved > this.model.context_window;
  }

  private cachedTokens(params: ResponseParams): number {
    const key = params.prompt_cache_key;
    if (!key || !this.model.capabilities.prompt_cache) return 0;
    const previous = this.cache.get(key);
    if (!previous) return 0;
    let cached = 0;
    for (const [index, segment] of segmentsOf(params).entries()) {
      if (previous[index] !== segment) break;
      cached += tokensOf(segment);
    }
    return cached;
  }

  private remember(params: ResponseParams, output: readonly OutputItem[]): void {
    const key = params.prompt_cache_key;
    if (!key || !this.model.capabilities.prompt_cache) return;
    this.cache.set(key, [
      ...segmentsOf(params),
      ...output.map((item) => canonicalJson({ ...item, id: undefined })),
    ]);
  }

  async *run(params: ResponseParams, control: RunControl = {}): AsyncGenerator<StreamEvent> {
    const validator = new StreamValidator({ prewarm: params.generate === false });
    let sequence = 0;
    const emit = (event: EventWithoutSequence): StreamEvent => {
      const full = { ...event, sequence_number: sequence } as StreamEvent;
      sequence += 1;
      validator.accept(full); // the mock must never produce an invalid stream
      return full;
    };

    const inputTokens = this.inputTokens(params);
    const cachedTokens = Math.min(this.cachedTokens(params), inputTokens);
    const response: ResponseObject = {
      id: this.ids.next("resp"),
      object: "response",
      created_at: this.now(),
      model: params.model,
      status: "in_progress",
      output: [],
      usage: null,
      incomplete_details: null,
      error: null,
    };
    control.onResponseId?.(response.id);
    yield emit({ type: "response.created", response: { ...response } });

    const output: OutputItem[] = [];
    let outputTokens = 0;
    let reasoningTokens = 0;
    const usage = (): Usage => ({
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: cachedTokens },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      total_tokens: inputTokens + outputTokens,
    });
    const terminal = (
      type: "response.completed" | "response.incomplete" | "response.failed",
      extra: Partial<ResponseObject>,
    ): StreamEvent => {
      const status = type === "response.completed" ? "completed" : type === "response.incomplete" ? "incomplete" : "failed";
      return emit({ type, response: { ...response, status, output: [...output], ...extra } });
    };

    if (params.generate === false) {
      this.remember(params, []);
      yield terminal("response.completed", { usage: usage() });
      return;
    }

    const plan = this.plan(params);
    const budget = params.max_output_tokens ?? this.model.max_output_tokens;
    let outputIndex = 0;

    // Streams `text` in chunks; returns the emitted text, or a stop reason.
    const stream = async function* (
      this: MockEngine,
      text: string,
      kind: "output" | "reasoning",
      toEvent: (delta: string) => EventWithoutSequence,
    ): AsyncGenerator<StreamEvent, { text: string; stop: "none" | "interrupted" | "budget" | "cancelled" }> {
      let emitted = "";
      const chars = Array.from(text);
      for (let start = 0; start < chars.length; start += this.chunkSize) {
        if (this.chunkDelayMs > 0) await delay(this.chunkDelayMs, control.signal);
        if (control.signal?.aborted) return { text: emitted, stop: "cancelled" };
        if (control.interrupted?.()) return { text: emitted, stop: "interrupted" };
        let chunk = chars.slice(start, start + this.chunkSize).join("");
        const remaining = budget - outputTokens;
        let exhausted = false;
        if (tokensOf(chunk) > remaining) {
          chunk = truncateToTokens(chunk, remaining);
          exhausted = true;
        }
        if (chunk !== "") {
          const cost = tokensOf(chunk);
          outputTokens += cost;
          if (kind === "reasoning") reasoningTokens += cost;
          emitted += chunk;
          yield emit(toEvent(chunk));
        }
        if (exhausted) return { text: emitted, stop: "budget" };
      }
      return { text: emitted, stop: "none" };
    };

    for (const [stepIndex, step] of plan.steps.entries()) {
      if (plan.failAfter && plan.failAfter.steps === stepIndex) {
        yield terminal("response.failed", {
          error: { code: plan.failAfter.code, message: plan.failAfter.message },
        });
        return;
      }
      const index = outputIndex;
      outputIndex += 1;
      let result: { text: string; stop: "none" | "interrupted" | "budget" | "cancelled" };

      switch (step.type) {
        case "message": {
          const id = this.ids.next("msg");
          const phase = step.phase ? { phase: step.phase } : {};
          yield emit({ type: "response.output_item.added", output_index: index, item: { type: "message", id, role: "assistant", content: [], ...phase } });
          const ref = { item_id: id, output_index: index, content_index: 0 };
          yield emit({ type: "response.content_part.added", ...ref, part: { type: "output_text", text: "" } });
          result = yield* stream.call(this, step.text, "output", (delta) => ({ type: "response.output_text.delta", ...ref, delta }));
          if (result.stop === "cancelled") return;
          if (result.stop === "interrupted") break;
          yield emit({ type: "response.output_text.done", ...ref, text: result.text });
          yield emit({ type: "response.content_part.done", ...ref, part: { type: "output_text", text: result.text } });
          const item: OutputItem = { type: "message", id, role: "assistant", content: [{ type: "output_text", text: result.text }], ...phase };
          output.push(item);
          yield emit({ type: "response.output_item.done", output_index: index, item });
          break;
        }
        case "reasoning": {
          const id = this.ids.next("rs");
          yield emit({ type: "response.output_item.added", output_index: index, item: { type: "reasoning", id, summary: [], content: [], encrypted_content: null } });
          const ref = { item_id: id, output_index: index };
          const summaries: { type: "summary_text"; text: string }[] = [];
          if (step.summary !== undefined && params.reasoning?.summary === "auto" && this.model.reasoning.summary) {
            const sref = { ...ref, summary_index: 0 };
            yield emit({ type: "response.reasoning_summary_part.added", ...sref, part: { type: "summary_text", text: "" } });
            result = yield* stream.call(this, step.summary, "reasoning", (delta) => ({ type: "response.reasoning_summary_text.delta", ...sref, delta }));
            if (result.stop === "cancelled") return;
            if (result.stop === "interrupted") break;
            yield emit({ type: "response.reasoning_summary_text.done", ...sref, text: result.text });
            yield emit({ type: "response.reasoning_summary_part.done", ...sref, part: { type: "summary_text", text: result.text } });
            summaries.push({ type: "summary_text", text: result.text });
            if (result.stop === "budget") {
              const item: OutputItem = { type: "reasoning", id, summary: summaries, content: [], encrypted_content: null };
              output.push(item);
              yield emit({ type: "response.output_item.done", output_index: index, item });
              break;
            }
          }
          const cref = { ...ref, content_index: 0 };
          result = yield* stream.call(this, step.text, "reasoning", (delta) => ({ type: "response.reasoning_text.delta", ...cref, delta }));
          if (result.stop === "cancelled") return;
          if (result.stop === "interrupted") break;
          yield emit({ type: "response.reasoning_text.done", ...cref, text: result.text });
          const item: OutputItem = { type: "reasoning", id, summary: summaries, content: [{ type: "reasoning_text", text: result.text }], encrypted_content: null };
          output.push(item);
          yield emit({ type: "response.output_item.done", output_index: index, item });
          break;
        }
        case "function_call":
        case "custom_tool_call": {
          const isFunction = step.type === "function_call";
          const id = this.ids.next(isFunction ? "fc" : "ctc");
          const callId = this.ids.next("call");
          const payload = isFunction ? step.arguments : step.input;
          const skeleton: OutputItem = isFunction
            ? { type: "function_call", id, call_id: callId, name: step.name, arguments: "" }
            : { type: "custom_tool_call", id, call_id: callId, name: step.name, input: "" };
          yield emit({ type: "response.output_item.added", output_index: index, item: skeleton });
          const ref = { item_id: id, output_index: index };
          result = yield* stream.call(this, payload, "output", (delta) =>
            isFunction
              ? { type: "response.function_call_arguments.delta", ...ref, delta }
              : { type: "response.custom_tool_call_input.delta", ...ref, delta },
          );
          if (result.stop === "cancelled") return;
          if (result.stop === "interrupted") break;
          yield emit(
            isFunction
              ? { type: "response.function_call_arguments.done", ...ref, arguments: result.text }
              : { type: "response.custom_tool_call_input.done", ...ref, input: result.text },
          );
          const item: OutputItem = isFunction
            ? { type: "function_call", id, call_id: callId, name: step.name, arguments: result.text }
            : { type: "custom_tool_call", id, call_id: callId, name: step.name, input: result.text };
          output.push(item);
          yield emit({ type: "response.output_item.done", output_index: index, item });
          break;
        }
      }

      if (result.stop === "interrupted") {
        yield terminal("response.incomplete", { usage: usage(), incomplete_details: { reason: "interrupted" } });
        return;
      }
      if (result.stop === "budget") {
        yield terminal("response.incomplete", { usage: usage(), incomplete_details: { reason: "max_output_tokens" } });
        return;
      }
    }
    if (plan.failAfter && plan.failAfter.steps === plan.steps.length) {
      yield terminal("response.failed", { error: { code: plan.failAfter.code, message: plan.failAfter.message } });
      return;
    }
    this.remember(params, output);
    yield terminal("response.completed", { usage: usage() });
  }

  /** Applies request-level constraints a real model would obey. */
  private plan(params: ResponseParams): MockPlan {
    const plan = this.script({ params, requestIndex: this.requestIndex });
    this.requestIndex += 1;
    const declared = new Map((params.tools ?? []).map((tool) => [tool.name, tool.type]));
    let steps = plan.steps.filter((step) => {
      if (step.type === "reasoning") return params.reasoning?.effort !== "none";
      if (step.type === "function_call" || step.type === "custom_tool_call") {
        if (params.tool_choice === "none") return false;
        const expected = step.type === "function_call" ? "function" : "custom";
        if (declared.get(step.name) !== expected) {
          throw new Error(`mock script called undeclared ${expected} tool '${step.name}'`);
        }
      }
      return true;
    });
    if (params.parallel_tool_calls !== true) {
      const firstCall = steps.findIndex((step) => step.type === "function_call" || step.type === "custom_tool_call");
      if (firstCall !== -1) steps = steps.slice(0, firstCall + 1);
    }
    return { ...plan, steps };
  }
}

function truncateToTokens(text: string, tokens: number): string {
  if (tokens <= 0) return "";
  let result = "";
  for (const char of Array.from(text)) {
    if (tokensOf(result + char) > tokens) break;
    result += char;
  }
  return result;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
