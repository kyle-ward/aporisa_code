// Middle truncation of tool output (ported from openai/codex, Apache-2.0:
// codex-rs/utils/string/src/truncate.rs and utils/output-truncation/src/lib.rs).
// Budgets are in UTF-8 bytes; a token is approximated as 4 bytes, as in codex.
import type { ToolOutput, TruncationPolicy } from "../../protocol/index.ts";

const BYTES_PER_TOKEN = 4;
const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function approxTokenCount(text: string): number {
  return Math.ceil(byteLength(text) / BYTES_PER_TOKEN);
}

export function approxTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function byteBudget(policy: TruncationPolicy): number {
  return policy.mode === "bytes" ? policy.limit : policy.limit * BYTES_PER_TOKEN;
}

/** codex's serialization allowance: history re-truncates only beyond 1.2x the policy. */
export function withAllowance(policy: TruncationPolicy): TruncationPolicy {
  return { mode: policy.mode, limit: Math.floor(policy.limit * 1.2) };
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
}

/**
 * Keeps the first and last halves of the byte budget on character boundaries and puts a
 * marker in between: `…N tokens truncated…` (tokens policy) or `…N chars truncated…`.
 */
export function truncateText(text: string, policy: TruncationPolicy): string {
  const bytes = encoder.encode(text);
  const budget = byteBudget(policy);
  if (bytes.byteLength <= budget) return text;
  const useTokens = policy.mode === "tokens";
  const leftBudget = Math.floor(budget / 2);
  const rightBudget = budget - leftBudget;
  let prefixEnd = leftBudget;
  while (prefixEnd > 0 && isContinuation(bytes[prefixEnd])) prefixEnd -= 1;
  let suffixStart = bytes.byteLength - rightBudget;
  while (suffixStart < bytes.byteLength && isContinuation(bytes[suffixStart])) suffixStart += 1;
  if (suffixStart < prefixEnd) suffixStart = prefixEnd;
  const decoder = new TextDecoder("utf-8");
  const prefix = decoder.decode(bytes.subarray(0, prefixEnd));
  const suffix = decoder.decode(bytes.subarray(suffixStart));
  const marker = useTokens
    ? `…${approxTokensFromBytes(bytes.byteLength - budget)} tokens truncated…`
    : `…${[...decoder.decode(bytes.subarray(prefixEnd, suffixStart))].length} chars truncated…`;
  return `${prefix}${marker}${suffix}`;
}

/** Truncates with codex's warning header, or returns the text unchanged when it fits. */
export function formattedTruncateText(text: string, policy: TruncationPolicy): string {
  if (byteLength(text) <= byteBudget(policy)) return text;
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return `Warning: truncated output (original token count: ${approxTokenCount(text)})\nTotal output lines: ${lines}\n\n${truncateText(text, policy)}`;
}

/**
 * The version of a tool output that enters history (DEVELOPMENT_PLAN.md 5.5): text is
 * truncated with the warning header; in content arrays the text parts are combined and
 * truncated together, images are kept.
 */
export function truncateToolOutput(output: ToolOutput, policy: TruncationPolicy): ToolOutput {
  if (typeof output === "string") return formattedTruncateText(output, policy);
  const texts = output.flatMap((part) => (part.type === "input_text" ? [part.text] : []));
  const combined = texts.join("\n");
  if (texts.length === 0 || byteLength(combined) <= byteBudget(policy)) return output;
  return [
    { type: "input_text", text: formattedTruncateText(combined, policy) },
    ...output.filter((part) => part.type === "input_image"),
  ];
}
