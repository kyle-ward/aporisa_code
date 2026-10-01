// Model metadata and capability declaration (docs/protocol.md §5), modelled on codex ModelInfo.
import { z } from "zod";

export const ReasoningEffort = z.enum(["none", "low", "medium", "high"]);

export const TruncationPolicy = z.strictObject({
  mode: z.enum(["bytes", "tokens"]),
  limit: z.number().int().positive(),
});

export const ModelReasoning = z.strictObject({
  supported_efforts: z.array(ReasoningEffort).min(1),
  default_effort: ReasoningEffort,
  summary: z.boolean(),
});

export const WireCapabilities = z.strictObject({
  parallel_tool_calls: z.boolean(),
  custom_tools: z.boolean(),
  structured_output: z.boolean(),
  prompt_cache: z.boolean(),
  prewarm: z.boolean(),
  input_tokens: z.boolean(),
  websocket: z.boolean(),
  reasoning_effort_updates: z.boolean(),
});

export const Model = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string().min(1),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  effective_context_window_percent: z.number().int().min(1).max(100),
  auto_compact_token_limit: z.number().int().positive().nullable(),
  truncation_policy: TruncationPolicy,
  input_modalities: z.array(z.enum(["text", "image"])).min(1),
  reasoning: ModelReasoning,
  capabilities: WireCapabilities,
});

export const ModelList = z.strictObject({
  object: z.literal("list"),
  data: z.array(Model),
});

export type ReasoningEffort = z.infer<typeof ReasoningEffort>;
export type WireCapabilities = z.infer<typeof WireCapabilities>;
export type TruncationPolicy = z.infer<typeof TruncationPolicy>;
export type Model = z.infer<typeof Model>;
export type ModelList = z.infer<typeof ModelList>;
export type CapabilityName = keyof WireCapabilities;
