// Item model of the Aporisa protocol (docs/protocol.md §7.1).
// Shapes follow the OpenAI Responses API items as used by openai/codex.
import { z } from "zod";
import { ReasoningEffort } from "./models.ts";

const DATA_IMAGE_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

export const InputTextPart = z.strictObject({
  type: z.literal("input_text"),
  text: z.string(),
});

export const InputImagePart = z.strictObject({
  type: z.literal("input_image"),
  image_url: z.string().regex(DATA_IMAGE_URL, "image_url must be a PNG or JPEG data URL"),
  detail: z.enum(["auto", "high"]).optional(),
});

export const OutputTextPart = z.strictObject({
  type: z.literal("output_text"),
  text: z.string(),
});

export const ContentPart = z.discriminatedUnion("type", [
  InputTextPart,
  InputImagePart,
  OutputTextPart,
]);

export const ToolOutputPart = z.discriminatedUnion("type", [InputTextPart, InputImagePart]);
export const ToolOutput = z.union([z.string(), z.array(ToolOutputPart).min(1)]);

export const SummaryTextPart = z.strictObject({
  type: z.literal("summary_text"),
  text: z.string(),
});

export const ReasoningTextPart = z.strictObject({
  type: z.literal("reasoning_text"),
  text: z.string(),
});

export const Role = z.enum(["user", "developer", "assistant"]);
export const MessagePhase = z.enum(["commentary", "final_answer"]);

const itemId = z.string().min(1).max(256);
const callId = z.string().min(1).max(256);
const toolName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

// --- Input items: ids are optional and carry no semantics for the server. ---

export const InputMessageItem = z.strictObject({
  type: z.literal("message"),
  id: itemId.optional(),
  role: Role,
  content: z.array(ContentPart).min(1),
  phase: MessagePhase.optional(),
});

export const InputReasoningItem = z.strictObject({
  type: z.literal("reasoning"),
  id: itemId.optional(),
  summary: z.array(SummaryTextPart),
  content: z.array(ReasoningTextPart).optional(),
  encrypted_content: z.string().nullable().optional(),
});

export const InputFunctionCallItem = z.strictObject({
  type: z.literal("function_call"),
  id: itemId.optional(),
  call_id: callId,
  name: toolName,
  arguments: z.string(),
});

export const FunctionCallOutputItem = z.strictObject({
  type: z.literal("function_call_output"),
  id: itemId.optional(),
  call_id: callId,
  output: ToolOutput,
});

export const InputCustomToolCallItem = z.strictObject({
  type: z.literal("custom_tool_call"),
  id: itemId.optional(),
  call_id: callId,
  name: toolName,
  input: z.string(),
});

export const CustomToolCallOutputItem = z.strictObject({
  type: z.literal("custom_tool_call_output"),
  id: itemId.optional(),
  call_id: callId,
  output: ToolOutput,
});

/** Input-only reasoning-effort update interpreted at its position in history (§6.1). */
export const ConfigurationUpdateItem = z.strictObject({
  type: z.literal("configuration_update"),
  reasoning: z.strictObject({ effort: ReasoningEffort }),
});

export const InputItem = z.discriminatedUnion("type", [
  InputMessageItem,
  InputReasoningItem,
  InputFunctionCallItem,
  FunctionCallOutputItem,
  InputCustomToolCallItem,
  CustomToolCallOutputItem,
  ConfigurationUpdateItem,
]);

// --- Output items: always carry a server id; message content may still be empty
// while the item is being streamed (response.output_item.added). ---

export const OutputMessageItem = z.strictObject({
  type: z.literal("message"),
  id: itemId,
  role: z.literal("assistant"),
  content: z.array(OutputTextPart),
  phase: MessagePhase.optional(),
});

export const OutputReasoningItem = z.strictObject({
  type: z.literal("reasoning"),
  id: itemId,
  summary: z.array(SummaryTextPart),
  content: z.array(ReasoningTextPart).optional(),
  encrypted_content: z.string().nullable(),
});

export const OutputFunctionCallItem = z.strictObject({
  type: z.literal("function_call"),
  id: itemId,
  call_id: callId,
  name: toolName,
  arguments: z.string(),
});

export const OutputCustomToolCallItem = z.strictObject({
  type: z.literal("custom_tool_call"),
  id: itemId,
  call_id: callId,
  name: toolName,
  input: z.string(),
});

export const OutputItem = z.discriminatedUnion("type", [
  OutputMessageItem,
  OutputReasoningItem,
  OutputFunctionCallItem,
  OutputCustomToolCallItem,
]);

export type InputTextPart = z.infer<typeof InputTextPart>;
export type InputImagePart = z.infer<typeof InputImagePart>;
export type OutputTextPart = z.infer<typeof OutputTextPart>;
export type ContentPart = z.infer<typeof ContentPart>;
export type ToolOutput = z.infer<typeof ToolOutput>;
export type Role = z.infer<typeof Role>;
export type MessagePhase = z.infer<typeof MessagePhase>;
export type InputItem = z.infer<typeof InputItem>;
export type ConfigurationUpdateItem = z.infer<typeof ConfigurationUpdateItem>;
export type OutputItem = z.infer<typeof OutputItem>;
export type OutputMessageItem = z.infer<typeof OutputMessageItem>;
export type OutputReasoningItem = z.infer<typeof OutputReasoningItem>;
export type OutputFunctionCallItem = z.infer<typeof OutputFunctionCallItem>;
export type OutputCustomToolCallItem = z.infer<typeof OutputCustomToolCallItem>;
