// Pre-stream retry policy (docs/protocol.md §9.3): only 429/503 admission failures,
// at most `maxRetries` times, honouring Retry-After plus jitter. Never after a stream started.
import { PRE_STREAM_RETRYABLE } from "../protocol/index.ts";
import { AporisaAbortError, AporisaApiError } from "./errors.ts";
import type { Diagnostic } from "./types.ts";

export interface RetryPolicy {
  maxRetries: number;
  /** Injected for tests; defaults to setTimeout-based sleep. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AporisaAbortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AporisaAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isRetryable(error: unknown): error is AporisaApiError {
  return error instanceof AporisaApiError && PRE_STREAM_RETRYABLE.has(error.code);
}

/** Runs `attempt` until it succeeds, a non-retryable error occurs, or retries run out. */
export async function withPreStreamRetry<T>(
  policy: RetryPolicy,
  attempt: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isRetryable(error) || retry >= policy.maxRetries) throw error;
      const baseMs = (error.retryAfterSeconds ?? 1) * 1000;
      const delayMs = Math.round(baseMs + baseMs * 0.25 * policy.random());
      policy.onDiagnostic?.({ kind: "retry", attempt: retry + 1, code: error.code, delayMs });
      await policy.sleep(delayMs, signal);
    }
  }
}
