// Generation request (docs/protocol.md §6) for both transports.
import { z } from "zod";
import { InputItem } from "./items.ts";
import { ReasoningEffort } from "./models.ts";
import { ToolSpec } from "./tools.ts";

export const JsonSchemaFormat = z.strictObject({
  type: z.literal("json_schema"),
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  schema: z.record(z.string(), z.unknown()),
  strict: z.literal(true),
});

export const RequestReasoning = z.strictObject({
  effort: ReasoningEffort,
  summary: z.literal("auto").optional(),
});

const ClientMetadata = z
  .record(z.string().max(64), z.string().max(512))
  .refine((value) => Object.keys(value).length <= 16, "client_metadata allows at most 16 keys");

/** Fields shared by the HTTP body and the WebSocket `response.create` message. */
export const ResponseParamsShape = {
  model: z.string().min(1).max(64),
  instructions: z.string().optional(),
  input: z.array(InputItem),
  tools: z.array(ToolSpec).optional(),
  tool_choice: z.enum(["auto", "none"]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning: RequestReasoning.optional(),
  text: z.strictObject({ format: JsonSchemaFormat }).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  prompt_cache_key: z.string().min(1).max(128).optional(),
  generate: z.boolean().optional(),
  client_metadata: ClientMetadata.optional(),
};

/** SDK-level parameters: the transport-independent part of a request. */
export const ResponseParams = z.strictObject({
  ...ResponseParamsShape,
  input: z.array(InputItem).min(1),
});

/** `POST /v1/responses` body. */
export const HttpCreateRequest = z.strictObject({
  ...ResponseParamsShape,
  input: z.array(InputItem).min(1),
  stream: z.literal(true),
});

/** WebSocket `response.create` client message. */
export const WsCreateMessage = z
  .strictObject({
    type: z.literal("response.create"),
    ...ResponseParamsShape,
    previous_response_id: z.string().min(1).max(256).optional(),
  })
  .refine(
    (message) => message.input.length > 0 || message.previous_response_id !== undefined,
    { message: "input may be empty only with previous_response_id", path: ["input"] },
  );

/** WebSocket `response.interrupt` client message. */
export const WsInterruptMessage = z.strictObject({
  type: z.literal("response.interrupt"),
  response_id: z.string().min(1).max(256),
});

/** `POST /v1/responses/input_tokens` body (X3). */
export const InputTokensRequest = z.strictObject({
  ...ResponseParamsShape,
  input: z.array(InputItem).min(1),
});

export const InputTokensResult = z.strictObject({
  object: z.literal("response.input_tokens"),
  input_tokens: z.number().int().nonnegative(),
});

export type ResponseParams = z.infer<typeof ResponseParams>;
export type HttpCreateRequest = z.infer<typeof HttpCreateRequest>;
export type WsCreateMessage = z.infer<typeof WsCreateMessage>;
export type WsInterruptMessage = z.infer<typeof WsInterruptMessage>;
export type InputTokensRequest = z.infer<typeof InputTokensRequest>;
export type InputTokensResult = z.infer<typeof InputTokensResult>;

/**
 * Request fields that must be identical for WebSocket incremental continuation
 * (docs/protocol.md §3.3). Everything except input, client_metadata and generate.
 */
export const CONTINUATION_PROPERTY_KEYS = [
  "model",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "max_output_tokens",
  "prompt_cache_key",
] as const satisfies readonly (keyof ResponseParams)[];
