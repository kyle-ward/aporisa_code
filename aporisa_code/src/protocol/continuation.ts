// WebSocket incremental continuation (docs/protocol.md §3.3), after codex
// `get_incremental_items` / `responses_request_properties_match`.
import { itemsEqualIgnoringIds, jsonEqual } from "./canonical.ts";
import type { InputItem, OutputItem } from "./items.ts";
import { CONTINUATION_PROPERTY_KEYS, type ResponseParams } from "./request.ts";

type ContinuationProps = Pick<ResponseParams, (typeof CONTINUATION_PROPERTY_KEYS)[number]>;

export function continuationProperties(params: ContinuationProps): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of CONTINUATION_PROPERTY_KEYS) picked[key] = params[key];
  return picked;
}

export function sameContinuationProperties(a: ContinuationProps, b: ContinuationProps): boolean {
  return jsonEqual(continuationProperties(a), continuationProperties(b));
}

/** Output items are valid input items; this documents the intended conversion. */
export function outputAsInput(items: readonly OutputItem[]): InputItem[] {
  return items.map((item) => item as InputItem);
}

/**
 * Returns the items to send after `previous_response_id`, or null when the next request
 * cannot continue the previous completed response and must be sent in full.
 */
export function incrementalInput(
  previous: ResponseParams,
  previousOutput: readonly OutputItem[],
  next: ResponseParams,
): InputItem[] | null {
  if (!sameContinuationProperties(previous, next)) return null;
  const base = [...previous.input, ...outputAsInput(previousOutput)];
  if (next.input.length < base.length) return null;
  for (const [index, item] of base.entries()) {
    if (!itemsEqualIgnoringIds(item, next.input[index])) return null;
  }
  return next.input.slice(base.length);
}
