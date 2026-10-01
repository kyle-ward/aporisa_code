// History invariants and token estimates (DEVELOPMENT_PLAN.md 6.1, 6.3).
import type { InputItem, Model, ToolSpec } from "../protocol/index.ts";
import { approxTokensFromBytes, byteLength } from "./tools/index.ts";

export const ABORTED_OUTPUT = "aborted";

/**
 * codex's normalize.rs: every call gets an output (a synthetic "aborted" one right after
 * the call when missing) and outputs without an earlier call are dropped. Returns the
 * same array when nothing needed fixing.
 */
export function normalizeHistory(items: readonly InputItem[]): InputItem[] {
  const answered = new Set<string>();
  const called = new Set<string>();
  for (const item of items) {
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") answered.add(item.call_id);
  }
  const out: InputItem[] = [];
  let changed = false;
  for (const item of items) {
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (!called.has(item.call_id)) {
        changed = true;
        continue;
      }
      out.push(item);
      continue;
    }
    out.push(item);
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      called.add(item.call_id);
      if (!answered.has(item.call_id)) {
        changed = true;
        out.push({
          type: item.type === "function_call" ? "function_call_output" : "custom_tool_call_output",
          call_id: item.call_id,
          output: ABORTED_OUTPUT,
        });
      }
    }
  }
  return changed ? out : (items as InputItem[]);
}

/** Calls in `items` that have no output yet. */
export function pendingCalls(items: readonly InputItem[]): string[] {
  const open = new Map<string, true>();
  for (const item of items) {
    if (item.type === "function_call" || item.type === "custom_tool_call") open.set(item.call_id, true);
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") open.delete(item.call_id);
  }
  return [...open.keys()];
}

/** Rough per-image cost: one token per 32x32 pixels at the backend's caps, plus framing. */
export const IMAGE_TOKEN_ESTIMATE = { auto: 1_100, high: 4_200 } as const;

/** Bytes/4 for text (codex), a fixed cost per image (base64 bytes would overcount ~300x). */
export function estimateItemTokens(item: InputItem): number {
  let tokens = 0;
  let rest: unknown = item;
  if (item.type === "message") {
    rest = { ...item, content: [] };
    for (const part of item.content) {
      tokens += part.type === "input_image" ? IMAGE_TOKEN_ESTIMATE[part.detail ?? "auto"] : approxTokensFromBytes(byteLength(part.text));
    }
  } else if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && Array.isArray(item.output)) {
    rest = { ...item, output: [] };
    for (const part of item.output) {
      tokens += part.type === "input_image" ? IMAGE_TOKEN_ESTIMATE[part.detail ?? "auto"] : approxTokensFromBytes(byteLength(part.text));
    }
  }
  return tokens + approxTokensFromBytes(byteLength(JSON.stringify(rest)));
}

export function estimateTokens(items: readonly InputItem[]): number {
  return items.reduce((sum, item) => sum + estimateItemTokens(item), 0);
}

export function estimatePromptTokens(instructions: string, tools: readonly ToolSpec[], items: readonly InputItem[]): number {
  return approxTokensFromBytes(byteLength(instructions) + byteLength(JSON.stringify(tools))) + estimateTokens(items);
}

/**
 * Most input tokens a request may carry: the effective window minus the output reserved
 * for this request (the backend rejects input + reserved output beyond the window).
 */
export function inputTokenLimit(model: Model, maxOutputTokens: number | undefined): number {
  const effective = Math.floor((model.context_window * model.effective_context_window_percent) / 100);
  return effective - (maxOutputTokens ?? model.max_output_tokens);
}
