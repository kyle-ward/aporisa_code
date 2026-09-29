// Public surface of the Aporisa SDK: interface C as seen by the harness.
import type { CapabilityName, InputTokensResult, Model, ResponseParams } from "../protocol/index.ts";
import type { ResponseStream } from "./response-stream.ts";

export type DriverName = "native" | "openrouter" | "stub";

/** Wire capabilities are booleans; the SDK reports how each one is provided (§5). */
export type CapabilityState = "supported" | "emulated" | "unsupported";
export type Capabilities = Record<CapabilityName, CapabilityState>;

export interface CallOptions {
  /** Hard cancellation: closes the underlying connection. */
  signal?: AbortSignal;
}

export interface InputTokenCount extends InputTokensResult {
  /** True when the count is a client-side estimate rather than a server count. */
  estimated: boolean;
}

export interface HealthStatus {
  live: boolean;
  ready: boolean;
}

export type Transport = "websocket" | "http";

/** Diagnostics are metadata only: never prompt, output or key material. */
export type Diagnostic =
  | { kind: "transport_fallback"; from: "websocket"; to: "http"; reason: string }
  | { kind: "continuation"; mode: "incremental" | "full"; reason?: string }
  | { kind: "retry"; attempt: number; code: string; delayMs: number };

export interface AporisaClient {
  readonly driver: DriverName;
  listModels(options?: CallOptions): Promise<Model[]>;
  getModel(model: string, options?: CallOptions): Promise<Model>;
  capabilities(model: string, options?: CallOptions): Promise<Capabilities>;
  /**
   * Starts a streamed generation. Pre-stream failures surface when the stream is
   * consumed (iteration or `final()`), as AporisaApiError / AporisaRequestError.
   */
  createResponse(params: ResponseParams, options?: CallOptions): ResponseStream;
  countInputTokens(params: ResponseParams, options?: CallOptions): Promise<InputTokenCount>;
  health(options?: CallOptions): Promise<HealthStatus>;
  close(): Promise<void>;
}
