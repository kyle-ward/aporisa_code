// WebSocket transport of the native driver (docs/protocol.md §3.3), after codex
// `ModelClientSession`: one connection, one in-flight response, incremental continuation
// from the last completed response, graceful interrupt.
import WebSocket from "ws";
import {
  incrementalInput,
  isTerminalEvent,
  StreamEvent,
  WsErrorMessage,
  type OutputItem,
  type ResponseObject,
  type ResponseParams,
} from "../../../protocol/index.ts";
import { AsyncQueue } from "../../async-queue.ts";
import {
  AporisaAbortError,
  AporisaApiError,
  AporisaProtocolError,
  AporisaTransportError,
} from "../../errors.ts";
import type { ResponseStreamSource } from "../../response-stream.ts";
import type { Diagnostic } from "../../types.ts";

/** Thrown when no connection could be established; the driver falls back to HTTP. */
export class WebSocketUnavailable extends Error {
  override readonly name = "WebSocketUnavailable";
}

export interface WebSocketTransportOptions {
  baseUrl: string;
  apiKey: string;
  connectTimeoutMs?: number;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
  /** Called when the connection misbehaved; the driver stops using WebSocket. */
  onBroken: (reason: string) => void;
}

interface Continuation {
  params: ResponseParams;
  output: OutputItem[];
  responseId: string;
}

type Frame = { kind: "message"; value: unknown } | { kind: "closed"; reason: string };

export class WebSocketTransport {
  private readonly url: string;
  private readonly options: WebSocketTransportOptions;
  private socket: WebSocket | null = null;
  private frames: AsyncQueue<Frame> | null = null;
  private busy = false;
  private continuation: Continuation | null = null;

  constructor(options: WebSocketTransportOptions) {
    this.options = options;
    this.url = `${options.baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/responses`;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /**
   * Sends `response.create` and waits for the first server message. Returns null when the
   * connection is busy with another response (the caller then uses HTTP).
   */
  async start(params: ResponseParams, signal?: AbortSignal): Promise<ResponseStreamSource | null> {
    if (this.busy) return null;
    if (signal?.aborted) throw new AporisaAbortError();
    this.busy = true;
    try {
      await this.ensureConnected(signal);
      let first = await this.sendCreate(params, true, signal);
      if (first.kind === "retry-full") first = await this.sendCreate(params, false, signal);
      if (first.kind === "reconnect") {
        this.dropConnection();
        await this.ensureConnected(signal);
        first = await this.sendCreate(params, false, signal);
      }
      if (first.kind !== "event") throw new AporisaTransportError("unable to start the response");
      return this.source(params, first.value, signal);
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.dropConnection();
  }

  private async ensureConnected(signal?: AbortSignal): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.frames) return;
    this.dropConnection();
    const socket = new WebSocket(this.url, {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      handshakeTimeout: this.options.connectTimeoutMs ?? 5_000,
      perMessageDeflate: false,
    });
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        socket.terminate();
        reject(new AporisaAbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("open", () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      socket.once("unexpected-response", (_request, response) => {
        signal?.removeEventListener("abort", onAbort);
        socket.terminate();
        reject(new WebSocketUnavailable(`upgrade rejected with HTTP ${response.statusCode ?? "?"}`));
      });
      socket.once("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(new WebSocketUnavailable(`connect failed: ${error.message}`));
      });
    });
    const frames = new AsyncQueue<Frame>();
    socket.on("message", (data, isBinary) => {
      if (isBinary) return frames.push({ kind: "closed", reason: "binary frame received" });
      try {
        frames.push({ kind: "message", value: JSON.parse(data.toString()) });
      } catch {
        frames.push({ kind: "closed", reason: "frame is not valid JSON" });
      }
    });
    socket.on("close", () => {
      frames.push({ kind: "closed", reason: "connection closed" });
      if (this.socket === socket) {
        this.socket = null;
        this.frames = null;
        this.continuation = null;
      }
    });
    socket.on("error", () => undefined);
    this.socket = socket;
    this.frames = frames;
  }

  private dropConnection(): void {
    const socket = this.socket;
    this.socket = null;
    this.frames = null;
    this.continuation = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  }

  private async sendCreate(
    params: ResponseParams,
    allowIncremental: boolean,
    signal?: AbortSignal,
  ): Promise<{ kind: "event"; value: unknown } | { kind: "retry-full" } | { kind: "reconnect" }> {
    const socket = this.socket;
    const frames = this.frames;
    if (!socket || !frames) throw new AporisaTransportError("connection is not open");
    const continuation = allowIncremental ? this.continuation : null;
    const delta = continuation ? incrementalInput(continuation.params, continuation.output, params) : null;
    const { input: _input, ...rest } = params;
    const message =
      continuation && delta
        ? { type: "response.create", ...rest, input: delta, previous_response_id: continuation.responseId }
        : { type: "response.create", ...params };
    this.options.onDiagnostic?.({
      kind: "continuation",
      mode: delta ? "incremental" : "full",
      ...(continuation && !delta ? { reason: "request diverged from the previous response" } : {}),
    });
    socket.send(JSON.stringify(message));

    const frame = await this.nextFrame(frames, signal);
    if (frame.kind === "closed") {
      this.markBroken(frame.reason);
      throw new AporisaTransportError(`WebSocket failed before the response started: ${frame.reason}`);
    }
    const error = WsErrorMessage.safeParse(frame.value);
    if (!error.success) return { kind: "event", value: frame.value };
    const body = error.data.error;
    if (body.code === "previous_response_not_found" && delta) {
      this.continuation = null;
      return { kind: "retry-full" };
    }
    if (body.code === "connection_limit_reached") return { kind: "reconnect" };
    throw new AporisaApiError({ status: error.data.status, ...body });
  }

  private async nextFrame(frames: AsyncQueue<Frame>, signal?: AbortSignal): Promise<Frame> {
    if (!signal) return (await frames.next()).value ?? { kind: "closed", reason: "connection closed" };
    if (signal.aborted) {
      this.dropConnection();
      throw new AporisaAbortError();
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        this.dropConnection();
        reject(new AporisaAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([frames.next(), aborted]);
      return result.value ?? { kind: "closed", reason: "connection closed" };
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private markBroken(reason: string): void {
    this.dropConnection();
    this.options.onBroken(reason);
  }

  private source(params: ResponseParams, firstEvent: unknown, signal?: AbortSignal): ResponseStreamSource {
    const frames = this.frames;
    const socket = this.socket;
    let finished = false;
    // Settle connection state before the terminal event reaches the caller, so a request
    // issued while handling that event can already reuse the connection and continue.
    const settle = (value: unknown): boolean => {
      const terminal = terminalResponse(value);
      if (!terminal) return false;
      finished = true;
      if (this.socket === socket) {
        this.continuation =
          terminal.status === "completed" ? { params, output: terminal.output, responseId: terminal.id } : null;
      }
      this.busy = false;
      return true;
    };
    const events = async function* (this: WebSocketTransport): AsyncGenerator<unknown> {
      try {
        if (settle(firstEvent)) return yield firstEvent;
        yield firstEvent;
        for (;;) {
          if (!frames) throw new AporisaTransportError("connection is not open");
          const frame = await this.nextFrame(frames, signal);
          if (frame.kind === "closed") {
            this.markBroken(frame.reason);
            throw new AporisaTransportError(`WebSocket failed mid-stream: ${frame.reason}`);
          }
          if (WsErrorMessage.safeParse(frame.value).success) {
            this.markBroken("error message received mid-stream");
            throw new AporisaProtocolError("received an error message after the response started");
          }
          if (settle(frame.value)) return yield frame.value;
          yield frame.value;
        }
      } finally {
        if (!finished) {
          // Abandoning a response mid-stream leaves the server generating; closing cancels it.
          if (this.socket === socket) this.dropConnection();
          this.busy = false;
        }
      }
    }.call(this);

    return {
      events,
      interrupt: (responseId: string) => {
        if (this.socket === socket && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "response.interrupt", response_id: responseId }));
        }
      },
      onFinish: (response: ResponseObject | null) => {
        // A protocol violation detected after the terminal event invalidates continuation.
        if (!response && this.socket === socket) this.continuation = null;
      },
    };
  }
}

function terminalResponse(value: unknown): ResponseObject | null {
  const parsed = StreamEvent.safeParse(value);
  return parsed.success && isTerminalEvent(parsed.data) ? parsed.data.response : null;
}
