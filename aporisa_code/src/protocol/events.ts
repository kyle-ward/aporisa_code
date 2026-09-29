// Response object and streaming events (docs/protocol.md §7.2, §7.3).
import { z } from "zod";
import { OutputItem, OutputTextPart, SummaryTextPart } from "./items.ts";
import { StreamErrorCode } from "./errors.ts";

const count = z.number().int().nonnegative();

export const Usage = z
  .strictObject({
    input_tokens: count,
    input_tokens_details: z.strictObject({ cached_tokens: count }),
    output_tokens: count,
    output_tokens_details: z.strictObject({ reasoning_tokens: count }),
    total_tokens: count,
  })
  .refine((usage) => usage.total_tokens === usage.input_tokens + usage.output_tokens, {
    message: "total_tokens must equal input_tokens + output_tokens",
  })
  .refine((usage) => usage.input_tokens_details.cached_tokens <= usage.input_tokens, {
    message: "cached_tokens cannot exceed input_tokens",
  })
  .refine((usage) => usage.output_tokens_details.reasoning_tokens <= usage.output_tokens, {
    message: "reasoning_tokens cannot exceed output_tokens",
  });

export const ResponseStatus = z.enum(["in_progress", "completed", "incomplete", "failed"]);

export const ResponseObject = z.strictObject({
  id: z.string().min(1).max(256),
  object: z.literal("response"),
  created_at: count,
  model: z.string().min(1),
  status: ResponseStatus,
  output: z.array(OutputItem),
  usage: Usage.nullable(),
  incomplete_details: z.strictObject({ reason: z.enum(["max_output_tokens", "interrupted"]) }).nullable(),
  error: z.strictObject({ code: StreamErrorCode, message: z.string() }).nullable(),
});

const seq = { sequence_number: count };
const itemRef = { item_id: z.string().min(1), output_index: count };

export const ResponseCreatedEvent = z.strictObject({
  type: z.literal("response.created"),
  ...seq,
  response: ResponseObject,
});
export const OutputItemAddedEvent = z.strictObject({
  type: z.literal("response.output_item.added"),
  ...seq,
  output_index: count,
  item: OutputItem,
});
export const OutputItemDoneEvent = z.strictObject({
  type: z.literal("response.output_item.done"),
  ...seq,
  output_index: count,
  item: OutputItem,
});
export const ContentPartAddedEvent = z.strictObject({
  type: z.literal("response.content_part.added"),
  ...seq,
  ...itemRef,
  content_index: count,
  part: OutputTextPart,
});
export const ContentPartDoneEvent = z.strictObject({
  type: z.literal("response.content_part.done"),
  ...seq,
  ...itemRef,
  content_index: count,
  part: OutputTextPart,
});
export const OutputTextDeltaEvent = z.strictObject({
  type: z.literal("response.output_text.delta"),
  ...seq,
  ...itemRef,
  content_index: count,
  delta: z.string(),
});
export const OutputTextDoneEvent = z.strictObject({
  type: z.literal("response.output_text.done"),
  ...seq,
  ...itemRef,
  content_index: count,
  text: z.string(),
});
export const ReasoningTextDeltaEvent = z.strictObject({
  type: z.literal("response.reasoning_text.delta"),
  ...seq,
  ...itemRef,
  content_index: count,
  delta: z.string(),
});
export const ReasoningTextDoneEvent = z.strictObject({
  type: z.literal("response.reasoning_text.done"),
  ...seq,
  ...itemRef,
  content_index: count,
  text: z.string(),
});
export const ReasoningSummaryPartAddedEvent = z.strictObject({
  type: z.literal("response.reasoning_summary_part.added"),
  ...seq,
  ...itemRef,
  summary_index: count,
  part: SummaryTextPart,
});
export const ReasoningSummaryPartDoneEvent = z.strictObject({
  type: z.literal("response.reasoning_summary_part.done"),
  ...seq,
  ...itemRef,
  summary_index: count,
  part: SummaryTextPart,
});
export const ReasoningSummaryTextDeltaEvent = z.strictObject({
  type: z.literal("response.reasoning_summary_text.delta"),
  ...seq,
  ...itemRef,
  summary_index: count,
  delta: z.string(),
});
export const ReasoningSummaryTextDoneEvent = z.strictObject({
  type: z.literal("response.reasoning_summary_text.done"),
  ...seq,
  ...itemRef,
  summary_index: count,
  text: z.string(),
});
export const FunctionCallArgumentsDeltaEvent = z.strictObject({
  type: z.literal("response.function_call_arguments.delta"),
  ...seq,
  ...itemRef,
  delta: z.string(),
});
export const FunctionCallArgumentsDoneEvent = z.strictObject({
  type: z.literal("response.function_call_arguments.done"),
  ...seq,
  ...itemRef,
  arguments: z.string(),
});
export const CustomToolCallInputDeltaEvent = z.strictObject({
  type: z.literal("response.custom_tool_call_input.delta"),
  ...seq,
  ...itemRef,
  delta: z.string(),
});
export const CustomToolCallInputDoneEvent = z.strictObject({
  type: z.literal("response.custom_tool_call_input.done"),
  ...seq,
  ...itemRef,
  input: z.string(),
});
export const ResponseCompletedEvent = z.strictObject({
  type: z.literal("response.completed"),
  ...seq,
  response: ResponseObject,
});
export const ResponseIncompleteEvent = z.strictObject({
  type: z.literal("response.incomplete"),
  ...seq,
  response: ResponseObject,
});
export const ResponseFailedEvent = z.strictObject({
  type: z.literal("response.failed"),
  ...seq,
  response: ResponseObject,
});

export const StreamEvent = z.discriminatedUnion("type", [
  ResponseCreatedEvent,
  OutputItemAddedEvent,
  OutputItemDoneEvent,
  ContentPartAddedEvent,
  ContentPartDoneEvent,
  OutputTextDeltaEvent,
  OutputTextDoneEvent,
  ReasoningTextDeltaEvent,
  ReasoningTextDoneEvent,
  ReasoningSummaryPartAddedEvent,
  ReasoningSummaryPartDoneEvent,
  ReasoningSummaryTextDeltaEvent,
  ReasoningSummaryTextDoneEvent,
  FunctionCallArgumentsDeltaEvent,
  FunctionCallArgumentsDoneEvent,
  CustomToolCallInputDeltaEvent,
  CustomToolCallInputDoneEvent,
  ResponseCompletedEvent,
  ResponseIncompleteEvent,
  ResponseFailedEvent,
]);

export type Usage = z.infer<typeof Usage>;
export type ResponseStatus = z.infer<typeof ResponseStatus>;
export type ResponseObject = z.infer<typeof ResponseObject>;
export type StreamEvent = z.infer<typeof StreamEvent>;
export type StreamEventType = StreamEvent["type"];
export type TerminalEvent = Extract<
  StreamEvent,
  { type: "response.completed" | "response.incomplete" | "response.failed" }
>;

export const TERMINAL_EVENT_TYPES: ReadonlySet<StreamEventType> = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

export function isTerminalEvent(event: StreamEvent): event is TerminalEvent {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

/** Distributive Omit so each event variant keeps its own fields. */
export type EventWithoutSequence = StreamEvent extends infer E
  ? E extends StreamEvent
    ? Omit<E, "sequence_number">
    : never
  : never;
