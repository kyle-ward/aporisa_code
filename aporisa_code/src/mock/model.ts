// Default mock model: declares every capability so the full interface C is exercised.
import type { Model } from "../protocol/index.ts";

export const MOCK_MODEL_ID = "aporisa-mock-v0";

export function mockModel(overrides: Partial<Model> = {}): Model {
  return {
    id: MOCK_MODEL_ID,
    object: "model",
    created: 1_790_000_000,
    owned_by: "local",
    context_window: 65_536,
    max_output_tokens: 8_192,
    effective_context_window_percent: 95,
    auto_compact_token_limit: null,
    truncation_policy: { mode: "bytes", limit: 10_000 },
    input_modalities: ["text", "image"],
    reasoning: { supported_efforts: ["none", "low", "medium", "high"], default_effort: "medium", summary: true },
    capabilities: {
      parallel_tool_calls: true,
      custom_tools: true,
      structured_output: true,
      prompt_cache: true,
      prewarm: true,
      input_tokens: true,
      websocket: true,
      reasoning_effort_updates: true,
    },
    ...overrides,
  };
}
