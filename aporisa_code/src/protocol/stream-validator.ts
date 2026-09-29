// Enforces the event ordering rules of docs/protocol.md §7.3. Used by the SDK on every
// stream it consumes, by the mock server on every stream it produces, and by the
// conformance suite against real backends.
import { jsonEqual } from "./canonical.ts";
import type { ResponseObject, StreamEvent } from "./events.ts";
import type { OutputItem } from "./items.ts";

export class StreamViolation extends Error {
  override readonly name = "StreamViolation";
}

export interface StreamValidatorOptions {
  /** A `generate:false` request: only response.created and response.completed are allowed. */
  prewarm?: boolean;
}

interface OpenItem {
  index: number;
  added: OutputItem;
  texts: string[];
  openText: number | null;
  textDone: boolean[];
  reasoning: string[];
  openReasoning: number | null;
  summaries: string[];
  openSummary: number | null;
  summaryDone: boolean[];
  payload: string;
  payloadDone: boolean;
}

export class StreamValidator {
  private expectedSequence = 0;
  private created: ResponseObject | null = null;
  private terminalResponse: ResponseObject | null = null;
  private current: OpenItem | null = null;
  private readonly completedItems: OutputItem[] = [];
  private readonly prewarm: boolean;

  constructor(options: StreamValidatorOptions = {}) {
    this.prewarm = options.prewarm ?? false;
  }

  get terminal(): ResponseObject | null {
    return this.terminalResponse;
  }

  get items(): readonly OutputItem[] {
    return this.completedItems;
  }

  get responseId(): string | null {
    return this.created?.id ?? null;
  }

  accept(event: StreamEvent): void {
    if (this.terminalResponse) fail("event received after the terminal event");
    if (event.sequence_number !== this.expectedSequence) {
      fail(`sequence_number ${event.sequence_number} != expected ${this.expectedSequence}`);
    }
    this.expectedSequence += 1;

    if (!this.created) {
      if (event.type !== "response.created") fail("first event must be response.created");
      const response = event.response;
      if (response.status !== "in_progress" || response.output.length > 0) {
        fail("response.created must be in_progress with empty output");
      }
      this.created = response;
      return;
    }

    switch (event.type) {
      case "response.created":
        return fail("duplicate response.created");
      case "response.output_item.added":
        return this.onItemAdded(event.output_index, event.item);
      case "response.output_item.done":
        return this.onItemDone(event.output_index, event.item);
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        return this.onTerminal(event.type, event.response);
      default:
        return this.onItemEvent(event);
    }
  }

  private onItemAdded(index: number, item: OutputItem): void {
    if (this.prewarm) fail("prewarm responses must not produce output items");
    if (this.current) fail("items must not interleave: previous item is still open");
    if (index !== this.completedItems.length) fail(`output_index ${index} is not the next index`);
    const skeletonOk =
      (item.type === "message" && item.content.length === 0) ||
      (item.type === "reasoning" && item.summary.length === 0 && (item.content ?? []).length === 0) ||
      (item.type === "function_call" && item.arguments === "") ||
      (item.type === "custom_tool_call" && item.input === "");
    if (!skeletonOk) fail("output_item.added must carry an empty item skeleton");
    this.current = {
      index,
      added: item,
      texts: [],
      openText: null,
      textDone: [],
      reasoning: [],
      openReasoning: null,
      summaries: [],
      openSummary: null,
      summaryDone: [],
      payload: "",
      payloadDone: false,
    };
  }

  private requireCurrent(itemId: string, outputIndex: number, type: OutputItem["type"]): OpenItem {
    const current = this.current;
    if (!current) return fail("item event without an open item");
    if (current.added.id !== itemId || current.index !== outputIndex) fail("item event refers to another item");
    if (current.added.type !== type) fail(`event is not valid for a ${current.added.type} item`);
    return current;
  }

  private onItemEvent(event: StreamEvent): void {
    switch (event.type) {
      case "response.content_part.added": {
        const item = this.requireCurrent(event.item_id, event.output_index, "message");
        if (item.openText !== null || event.content_index !== item.texts.length) fail("unexpected content_part.added");
        if (event.part.text !== "") fail("content_part.added must carry an empty part");
        item.texts.push("");
        item.textDone.push(false);
        item.openText = event.content_index;
        return;
      }
      case "response.output_text.delta": {
        const item = this.requireCurrent(event.item_id, event.output_index, "message");
        if (item.openText !== event.content_index || item.textDone[event.content_index]) fail("delta outside an open part");
        item.texts[event.content_index] += event.delta;
        return;
      }
      case "response.output_text.done": {
        const item = this.requireCurrent(event.item_id, event.output_index, "message");
        if (item.openText !== event.content_index || item.textDone[event.content_index]) fail("unexpected output_text.done");
        if (item.texts[event.content_index] !== event.text) fail("output_text.done text differs from deltas");
        item.textDone[event.content_index] = true;
        return;
      }
      case "response.content_part.done": {
        const item = this.requireCurrent(event.item_id, event.output_index, "message");
        if (item.openText !== event.content_index || !item.textDone[event.content_index]) fail("unexpected content_part.done");
        if (event.part.text !== item.texts[event.content_index]) fail("content_part.done text differs from deltas");
        item.openText = null;
        return;
      }
      case "response.reasoning_text.delta":
      case "response.reasoning_text.done": {
        const item = this.requireCurrent(event.item_id, event.output_index, "reasoning");
        if (item.openReasoning === null) {
          if (event.content_index !== item.reasoning.length) fail("reasoning content_index is not the next index");
          item.reasoning.push("");
          item.openReasoning = event.content_index;
        } else if (item.openReasoning !== event.content_index) {
          fail("reasoning event for a closed content part");
        }
        if (event.type === "response.reasoning_text.delta") {
          item.reasoning[event.content_index] += event.delta;
        } else {
          if (item.reasoning[event.content_index] !== event.text) fail("reasoning_text.done text differs from deltas");
          item.openReasoning = null;
        }
        return;
      }
      case "response.reasoning_summary_part.added": {
        const item = this.requireCurrent(event.item_id, event.output_index, "reasoning");
        if (item.openSummary !== null || event.summary_index !== item.summaries.length) fail("unexpected summary part");
        if (event.part.text !== "") fail("reasoning_summary_part.added must carry an empty part");
        item.summaries.push("");
        item.summaryDone.push(false);
        item.openSummary = event.summary_index;
        return;
      }
      case "response.reasoning_summary_text.delta": {
        const item = this.requireCurrent(event.item_id, event.output_index, "reasoning");
        if (item.openSummary !== event.summary_index || item.summaryDone[event.summary_index]) fail("summary delta outside an open part");
        item.summaries[event.summary_index] += event.delta;
        return;
      }
      case "response.reasoning_summary_text.done": {
        const item = this.requireCurrent(event.item_id, event.output_index, "reasoning");
        if (item.openSummary !== event.summary_index || item.summaryDone[event.summary_index]) fail("unexpected summary done");
        if (item.summaries[event.summary_index] !== event.text) fail("summary text differs from deltas");
        item.summaryDone[event.summary_index] = true;
        return;
      }
      case "response.reasoning_summary_part.done": {
        const item = this.requireCurrent(event.item_id, event.output_index, "reasoning");
        if (item.openSummary !== event.summary_index || !item.summaryDone[event.summary_index]) fail("unexpected summary part done");
        if (event.part.text !== item.summaries[event.summary_index]) fail("summary part text differs from deltas");
        item.openSummary = null;
        return;
      }
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done": {
        const item = this.requireCurrent(event.item_id, event.output_index, "function_call");
        if (item.payloadDone) fail("function call arguments already done");
        if (event.type === "response.function_call_arguments.delta") item.payload += event.delta;
        else {
          if (item.payload !== event.arguments) fail("arguments.done differs from deltas");
          item.payloadDone = true;
        }
        return;
      }
      case "response.custom_tool_call_input.delta":
      case "response.custom_tool_call_input.done": {
        const item = this.requireCurrent(event.item_id, event.output_index, "custom_tool_call");
        if (item.payloadDone) fail("custom tool input already done");
        if (event.type === "response.custom_tool_call_input.delta") item.payload += event.delta;
        else {
          if (item.payload !== event.input) fail("custom_tool_call_input.done differs from deltas");
          item.payloadDone = true;
        }
        return;
      }
      default:
        fail(`unexpected ${event.type}`);
    }
  }

  private onItemDone(index: number, item: OutputItem): void {
    const current = this.current;
    if (!current || current.index !== index) fail("output_item.done without a matching open item");
    const added = current.added;
    if (added.type !== item.type || added.id !== item.id) fail("output_item.done does not match the added item");
    switch (item.type) {
      case "message": {
        if (current.openText !== null) fail("message done while a content part is open");
        const texts = item.content.map((part) => part.text);
        if (!jsonEqual(texts, current.texts)) fail("message content differs from streamed text");
        if (added.type === "message" && added.role !== item.role) fail("message role changed");
        break;
      }
      case "reasoning": {
        if (current.openReasoning !== null || current.openSummary !== null) fail("reasoning done while a part is open");
        const content = (item.content ?? []).map((part) => part.text);
        if (!jsonEqual(content, current.reasoning)) fail("reasoning content differs from streamed text");
        if (!jsonEqual(item.summary.map((part) => part.text), current.summaries)) fail("summary differs from streamed text");
        break;
      }
      case "function_call": {
        if (!current.payloadDone || item.arguments !== current.payload) fail("function call arguments incomplete");
        if (added.type === "function_call" && (added.call_id !== item.call_id || added.name !== item.name)) {
          fail("function call identity changed");
        }
        break;
      }
      case "custom_tool_call": {
        if (!current.payloadDone || item.input !== current.payload) fail("custom tool input incomplete");
        if (added.type === "custom_tool_call" && (added.call_id !== item.call_id || added.name !== item.name)) {
          fail("custom tool call identity changed");
        }
        break;
      }
    }
    this.completedItems.push(item);
    this.current = null;
  }

  private onTerminal(type: "response.completed" | "response.incomplete" | "response.failed", response: ResponseObject): void {
    const created = this.created;
    if (!created || response.id !== created.id || response.model !== created.model) {
      fail("terminal response does not match response.created");
    }
    const expectedStatus = type.slice("response.".length);
    if (response.status !== expectedStatus) fail(`${type} must carry status ${expectedStatus}`);
    if (!jsonEqual(response.output, this.completedItems)) {
      fail("terminal output differs from the completed items");
    }
    switch (type) {
      case "response.completed":
        if (this.current) fail("response.completed while an item is still open");
        if (!response.usage || response.incomplete_details || response.error) fail("invalid completed response");
        if (this.prewarm && (response.output.length > 0 || response.usage.output_tokens !== 0)) {
          fail("prewarm must complete without output tokens");
        }
        break;
      case "response.incomplete":
        if (this.prewarm) fail("prewarm must not end incomplete");
        if (!response.usage || !response.incomplete_details || response.error) fail("invalid incomplete response");
        break;
      case "response.failed":
        if (!response.error || response.incomplete_details) fail("invalid failed response");
        break;
    }
    this.terminalResponse = response;
  }
}

function fail(message: string): never {
  throw new StreamViolation(message);
}
