// Error bodies and codes (docs/protocol.md §9).
import { z } from "zod";

export const ErrorType = z.enum([
  "invalid_request_error",
  "authentication_error",
  "rate_limit_error",
  "server_error",
]);

export const HttpErrorCode = z.enum([
  "invalid_request",
  "unsupported_parameter",
  "unsupported_schema",
  "invalid_image",
  "context_length_exceeded",
  "invalid_api_key",
  "model_not_found",
  "not_found",
  "request_timeout",
  "request_too_large",
  "unsupported_media_type",
  "previous_response_not_found",
  "response_in_progress",
  "queue_full",
  "queue_timeout",
  "service_not_ready",
  "connection_limit_reached",
  "internal_error",
]);

export const StreamErrorCode = z.enum([
  "server_error",
  "inference_timeout",
  "output_limit_exceeded",
  "structured_output_invalid",
  "engine_failure",
  "tool_call_invalid",
]);

export const ErrorBody = z.strictObject({
  error: z.strictObject({
    type: ErrorType,
    code: HttpErrorCode,
    message: z.string(),
    param: z.string().nullable(),
  }),
});

/** WebSocket `error` server message: a pre-stream failure on a WebSocket connection. */
export const WsErrorMessage = z.strictObject({
  type: z.literal("error"),
  status: z.number().int().min(400).max(599),
  error: ErrorBody.shape.error,
});

export type ErrorType = z.infer<typeof ErrorType>;
export type HttpErrorCode = z.infer<typeof HttpErrorCode>;
export type StreamErrorCode = z.infer<typeof StreamErrorCode>;
export type ErrorBody = z.infer<typeof ErrorBody>;
export type WsErrorMessage = z.infer<typeof WsErrorMessage>;

/** Canonical HTTP status and error type for each pre-stream error code. */
export const HTTP_ERROR_STATUS: Record<HttpErrorCode, { status: number; type: ErrorType }> = {
  invalid_request: { status: 400, type: "invalid_request_error" },
  unsupported_parameter: { status: 400, type: "invalid_request_error" },
  unsupported_schema: { status: 400, type: "invalid_request_error" },
  invalid_image: { status: 400, type: "invalid_request_error" },
  context_length_exceeded: { status: 400, type: "invalid_request_error" },
  invalid_api_key: { status: 401, type: "authentication_error" },
  model_not_found: { status: 404, type: "invalid_request_error" },
  not_found: { status: 404, type: "invalid_request_error" },
  request_timeout: { status: 408, type: "invalid_request_error" },
  previous_response_not_found: { status: 409, type: "invalid_request_error" },
  response_in_progress: { status: 409, type: "invalid_request_error" },
  request_too_large: { status: 413, type: "invalid_request_error" },
  unsupported_media_type: { status: 415, type: "invalid_request_error" },
  queue_full: { status: 429, type: "rate_limit_error" },
  queue_timeout: { status: 429, type: "rate_limit_error" },
  internal_error: { status: 500, type: "server_error" },
  service_not_ready: { status: 503, type: "server_error" },
  connection_limit_reached: { status: 503, type: "server_error" },
};

/** Codes that are retryable before the stream starts (docs/protocol.md §9.3). */
export const PRE_STREAM_RETRYABLE: ReadonlySet<HttpErrorCode> = new Set([
  "queue_full",
  "queue_timeout",
  "service_not_ready",
]);
