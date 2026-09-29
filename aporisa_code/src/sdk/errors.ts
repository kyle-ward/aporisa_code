// Error taxonomy of the Aporisa SDK. Harness code branches on these classes and on
// `code`, never on message text.
import type { ErrorType, HttpErrorCode } from "../protocol/index.ts";

export class AporisaError extends Error {
  override readonly name: string = "AporisaError";
}

/** A pre-stream error returned by the server (HTTP error or WebSocket `error` message). */
export class AporisaApiError extends AporisaError {
  override readonly name = "AporisaApiError";
  readonly status: number;
  readonly type: ErrorType;
  readonly code: HttpErrorCode;
  readonly param: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    type: ErrorType;
    code: HttpErrorCode;
    message: string;
    param: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.param = init.param;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

/** The SDK refused to send a request that the target does not support or that is malformed. */
export class AporisaRequestError extends AporisaError {
  override readonly name = "AporisaRequestError";
  readonly code: HttpErrorCode;
  readonly param: string | null;

  constructor(code: HttpErrorCode, param: string | null, message: string) {
    super(message);
    this.code = code;
    this.param = param;
  }
}

/** The peer violated the protocol (bad JSON, unknown event, broken ordering, missing terminal). */
export class AporisaProtocolError extends AporisaError {
  override readonly name = "AporisaProtocolError";
}

/** The connection failed; whether the server started generating is unknown. */
export class AporisaTransportError extends AporisaError {
  override readonly name = "AporisaTransportError";
}

/** The caller aborted the request through its AbortSignal. */
export class AporisaAbortError extends AporisaError {
  override readonly name = "AporisaAbortError";
  constructor(message = "The request was aborted.") {
    super(message);
  }
}
