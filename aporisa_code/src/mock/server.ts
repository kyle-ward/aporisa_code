// Mock Aporisa backend: implements both transports of docs/protocol.md on top of MockEngine.
// It is the executable contract that the SDK is developed against before the real backend exists.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { z } from "zod";
import {
  HTTP_ERROR_STATUS,
  HttpCreateRequest,
  InputTokensRequest,
  isTerminalEvent,
  outputAsInput,
  parseStrictJson,
  inputImages,
  requestViolation,
  sameContinuationProperties,
  StrictJsonError,
  WsCreateMessage,
  WsInterruptMessage,
  type HttpErrorCode,
  type Model,
  type OutputItem,
  type ResponseParams,
  type StreamEvent,
} from "../protocol/index.ts";
import { Admission } from "./admission.ts";
import { MockEngine, type MockScript } from "./engine.ts";
import { mockModel } from "./model.ts";

export interface MockServerOptions {
  apiKey?: string;
  model?: Model;
  script?: MockScript;
  chunkSize?: number;
  chunkDelayMs?: number;
  maxBodyBytes?: number;
  /** Most input_image parts one request may hold, history and tool outputs included (§11). */
  maxImages?: number;
  concurrency?: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
  keepaliveMs?: number;
  /** Maximum WebSocket connection lifetime; unlimited when omitted. */
  connectionLifetimeMs?: number;
  retryAfterSeconds?: number;
  /** Test hook: refuse WebSocket upgrades even though the model declares the capability. */
  rejectWebSocketUpgrade?: boolean;
}

export interface MockServerStats {
  httpResponses: number;
  wsResponses: number;
  wsFullCreates: number;
  wsIncrementalCreates: number;
  wsInterrupts: number;
  wsConnections: number;
}

interface PreparedError {
  code: HttpErrorCode;
  param: string | null;
  message: string;
}

type Prepared = { ok: true; params: ResponseParams } | { ok: false; error: PreparedError };

interface Continuation {
  params: ResponseParams;
  output: OutputItem[];
  responseId: string;
}

export class MockServer {
  readonly apiKey: string;
  readonly model: Model;
  readonly engine: MockEngine;
  /** Toggle to exercise service_not_ready. */
  ready = true;
  readonly stats: MockServerStats = {
    httpResponses: 0,
    wsResponses: 0,
    wsFullCreates: 0,
    wsIncrementalCreates: 0,
    wsInterrupts: 0,
    wsConnections: 0,
  };
  /** Full (continuation-expanded) request parameters of every admitted generation. */
  readonly requests: ResponseParams[] = [];

  private readonly options: Required<Pick<MockServerOptions, "maxBodyBytes" | "maxImages" | "keepaliveMs" | "retryAfterSeconds">> &
    Pick<MockServerOptions, "connectionLifetimeMs" | "rejectWebSocketUpgrade">;
  private readonly admission: Admission;
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<Socket>();

  constructor(options: MockServerOptions = {}) {
    this.apiKey = options.apiKey ?? "mock-api-key";
    this.model = options.model ?? mockModel();
    this.engine = new MockEngine({
      model: this.model,
      ...(options.script ? { script: options.script } : {}),
      ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
      ...(options.chunkDelayMs !== undefined ? { chunkDelayMs: options.chunkDelayMs } : {}),
    });
    this.options = {
      maxBodyBytes: options.maxBodyBytes ?? 4 * 1024 * 1024,
      maxImages: options.maxImages ?? 64,
      keepaliveMs: options.keepaliveMs ?? 15_000,
      retryAfterSeconds: options.retryAfterSeconds ?? 1,
      ...(options.connectionLifetimeMs !== undefined ? { connectionLifetimeMs: options.connectionLifetimeMs } : {}),
      ...(options.rejectWebSocketUpgrade ? { rejectWebSocketUpgrade: true } : {}),
    };
    this.admission = new Admission({
      concurrency: options.concurrency ?? 1,
      maxQueue: options.maxQueue ?? 2,
      queueTimeoutMs: options.queueTimeoutMs ?? 60_000,
    });
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(() => {
        if (!response.headersSent) this.sendError(response, "internal_error", null, "Internal error.");
        else response.destroy();
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket as Socket, head));
  }

  /** Starts listening on 127.0.0.1 and returns the base URL (ending in /v1). */
  async start(port = 0): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(port, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // --- HTTP -----------------------------------------------------------------------------

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://mock");
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /health/live") return this.sendJson(response, 200, { status: "alive" });
    if (route === "GET /health/ready") {
      return this.sendJson(response, this.ready ? 200 : 503, { status: this.ready ? "ready" : "not_ready" });
    }
    if (!url.pathname.startsWith("/v1/")) return this.sendError(response, "not_found", null, "Unknown endpoint.");
    if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
      return this.sendError(response, "invalid_api_key", null, "Invalid API key.");
    }
    if (route === "GET /v1/models") return this.sendJson(response, 200, { object: "list", data: [this.model] });
    if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      if (id !== this.model.id) return this.sendError(response, "model_not_found", "model", "Unknown model.");
      return this.sendJson(response, 200, this.model);
    }
    if (route === "POST /v1/responses") return this.handleHttpCreate(request, response);
    if (route === "POST /v1/responses/input_tokens" && this.model.capabilities.input_tokens) {
      return this.handleInputTokens(request, response);
    }
    return this.sendError(response, "not_found", null, "Unknown endpoint.");
  }

  private async readJson(request: IncomingMessage, response: ServerResponse): Promise<unknown | undefined> {
    if (request.headers["content-encoding"]) {
      this.sendError(response, "unsupported_media_type", null, "Compressed bodies are not supported.");
      return undefined;
    }
    const contentType = (request.headers["content-type"] ?? "").toLowerCase().replace(/\s+/g, "");
    if (contentType !== "application/json" && contentType !== "application/json;charset=utf-8") {
      this.sendError(response, "unsupported_media_type", null, "Body must be application/json.");
      return undefined;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > this.options.maxBodyBytes) {
        this.sendError(response, "request_too_large", null, "Request body is too large.");
        request.destroy();
        return undefined;
      }
      chunks.push(chunk);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      return parseStrictJson(text);
    } catch (error) {
      const reason = error instanceof StrictJsonError ? error.message : "body is not valid UTF-8";
      this.sendError(response, "invalid_request", null, `Invalid JSON: ${reason}.`);
      return undefined;
    }
  }

  private async handleHttpCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readJson(request, response);
    if (body === undefined) return;
    if (isObject(body) && "previous_response_id" in body) {
      return this.sendError(response, "unsupported_parameter", "previous_response_id", "previous_response_id is only valid on WebSocket.");
    }
    const prepared = this.prepare(parseShape(HttpCreateRequest, body));
    if (!prepared.ok) return this.sendError(response, prepared.error.code, prepared.error.param, prepared.error.message);

    const cancel = new AbortController();
    const onClose = () => cancel.abort();
    response.on("close", onClose);
    const admitted = await this.admission.acquire(cancel.signal);
    if (!admitted.ok) {
      if (cancel.signal.aborted) return;
      return this.sendError(response, admitted.code, null, "The server is busy.", this.options.retryAfterSeconds);
    }
    this.stats.httpResponses += 1;
    this.requests.push(prepared.params);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-request-id": randomUUID(),
      connection: "keep-alive",
    });
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), this.options.keepaliveMs);
    try {
      for await (const event of this.engine.run(prepared.params, { signal: cancel.signal })) {
        if (cancel.signal.aborted) break;
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      clearInterval(keepalive);
      admitted.release();
      response.off("close", onClose);
      response.end();
    }
  }

  private async handleInputTokens(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readJson(request, response);
    if (body === undefined) return;
    const shaped = parseShape(InputTokensRequest, body);
    if (!shaped.ok) return this.sendError(response, shaped.error.code, shaped.error.param, shaped.error.message);
    if (shaped.value.model !== this.model.id) return this.sendError(response, "model_not_found", "model", "Unknown model.");
    const violation = requestViolation(shaped.value, this.model) ?? this.limitViolation(shaped.value);
    if (violation) return this.sendError(response, violation.code, violation.param, violation.message);
    return this.sendJson(response, 200, { object: "response.input_tokens", input_tokens: this.engine.inputTokens(shaped.value) });
  }

  /** Model, capability, structure and context checks shared by both transports. */
  private prepare(shaped: Shaped<ResponseParams & object>): Prepared {
    if (!shaped.ok) return shaped;
    const { stream: _stream, type: _type, previous_response_id: _previous, ...params } = shaped.value as ResponseParams & {
      stream?: true;
      type?: string;
      previous_response_id?: string;
    };
    if (params.model !== this.model.id) return fail("model_not_found", "model", "Unknown model.");
    const violation = requestViolation(params, this.model) ?? this.limitViolation(params);
    if (violation) return { ok: false, error: violation };
    if (this.engine.exceedsContext(params)) {
      return fail("context_length_exceeded", "input", "Input exceeds the model context window.");
    }
    if (!this.ready) return fail("service_not_ready", null, "The service is not ready.");
    return { ok: true, params };
  }

  /** Server limits beyond the model's (§11). */
  private limitViolation(params: Pick<ResponseParams, "input">): PreparedError | null {
    if (inputImages(params.input).length > this.options.maxImages) {
      return { code: "invalid_request", param: "input", message: "The request holds too many images." };
    }
    return null;
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-request-id": randomUUID() });
    response.end(JSON.stringify(body));
  }

  private sendError(response: ServerResponse, code: HttpErrorCode, param: string | null, message: string, retryAfter?: number): void {
    const { status, type } = HTTP_ERROR_STATUS[code];
    const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
    if (retryAfter !== undefined || code === "service_not_ready") {
      headers["retry-after"] = String(retryAfter ?? this.options.retryAfterSeconds);
    }
    response.writeHead(status, headers);
    response.end(JSON.stringify({ error: { type, code, message, param } }));
  }

  // --- WebSocket ------------------------------------------------------------------------

  private handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://mock");
    const reject = (code: HttpErrorCode, message: string) => {
      const { status, type } = HTTP_ERROR_STATUS[code];
      const body = JSON.stringify({ error: { type, code, message, param: null } });
      socket.end(
        `HTTP/1.1 ${status} Error\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    };
    if (url.pathname !== "/v1/responses" || !this.model.capabilities.websocket) return reject("not_found", "Unknown endpoint.");
    if (request.headers.authorization !== `Bearer ${this.apiKey}`) return reject("invalid_api_key", "Invalid API key.");
    if (this.options.rejectWebSocketUpgrade) return reject("service_not_ready", "WebSocket is unavailable.");
    this.wss.handleUpgrade(request, socket, head, (ws) => this.handleConnection(ws));
  }

  private handleConnection(ws: WebSocket): void {
    this.stats.wsConnections += 1;
    let busy = false;
    let expired = false;
    let continuation: Continuation | null = null;
    let active: { responseId: string | null; interrupted: boolean; cancel: AbortController } | null = null;

    const sendError = (code: HttpErrorCode, param: string | null, message: string) => {
      const { status, type } = HTTP_ERROR_STATUS[code];
      ws.send(JSON.stringify({ type: "error", status, error: { type, code, message, param } }));
    };
    const expire = () => {
      sendError("connection_limit_reached", null, "Connection lifetime reached; reconnect.");
      ws.close();
    };
    const lifetime =
      this.options.connectionLifetimeMs !== undefined
        ? setTimeout(() => {
            expired = true;
            if (!busy) expire();
          }, this.options.connectionLifetimeMs)
        : undefined;

    ws.on("close", () => {
      if (lifetime) clearTimeout(lifetime);
      active?.cancel.abort();
      continuation = null;
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return sendError("invalid_request", null, "Binary frames are not supported.");
      let message: unknown;
      try {
        message = parseStrictJson(data.toString());
      } catch {
        return sendError("invalid_request", null, "Invalid JSON.");
      }
      const type = isObject(message) ? message.type : undefined;
      if (type === "response.interrupt") {
        const parsed = WsInterruptMessage.safeParse(message);
        if (!parsed.success) return sendError("invalid_request", null, "Invalid interrupt message.");
        if (active && active.responseId === parsed.data.response_id) {
          active.interrupted = true;
          this.stats.wsInterrupts += 1;
        }
        return;
      }
      if (type !== "response.create") return sendError("invalid_request", "type", "Unknown message type.");
      if (busy) return sendError("response_in_progress", null, "A response is already in progress.");

      const shaped = parseShape(WsCreateMessage, message);
      if (!shaped.ok) return sendError(shaped.error.code, shaped.error.param, shaped.error.message);
      let full: unknown = shaped.value;
      if (shaped.value.previous_response_id !== undefined) {
        const { type: _type, previous_response_id: previousId, ...rest } = shaped.value;
        if (!continuation || continuation.responseId !== previousId || !sameContinuationProperties(continuation.params, rest)) {
          return sendError("previous_response_not_found", "previous_response_id", "Previous response was not found.");
        }
        full = { ...rest, input: [...continuation.params.input, ...outputAsInput(continuation.output), ...rest.input] };
        this.stats.wsIncrementalCreates += 1;
      } else {
        this.stats.wsFullCreates += 1;
      }
      const prepared = this.prepare({ ok: true, value: full as ResponseParams });
      if (!prepared.ok) return sendError(prepared.error.code, prepared.error.param, prepared.error.message);

      busy = true;
      continuation = null;
      const current = { responseId: null as string | null, interrupted: false, cancel: new AbortController() };
      active = current;
      void (async () => {
        const admitted = await this.admission.acquire(current.cancel.signal);
        if (!admitted.ok) {
          busy = false;
          active = null;
          if (!current.cancel.signal.aborted) sendError(admitted.code, null, "The server is busy.");
          return;
        }
        this.stats.wsResponses += 1;
        this.requests.push(prepared.params);
        let terminal: StreamEvent | null = null;
        try {
          const run = this.engine.run(prepared.params, {
            signal: current.cancel.signal,
            interrupted: () => current.interrupted,
            onResponseId: (id) => {
              current.responseId = id;
            },
          });
          for await (const event of run) {
            if (current.cancel.signal.aborted) break;
            if (isTerminalEvent(event)) {
              terminal = event;
              continuation =
                event.response.status === "completed"
                  ? { params: prepared.params, output: event.response.output, responseId: event.response.id }
                  : null;
              busy = false;
              active = null;
            }
            ws.send(JSON.stringify(event));
          }
        } finally {
          admitted.release();
          if (!terminal) {
            busy = false;
            active = null;
          }
          if (expired && !busy && ws.readyState === ws.OPEN) expire();
        }
      })();
    });
  }
}

type Shaped<T> = { ok: true; value: T } | { ok: false; error: PreparedError };

function parseShape<S extends z.ZodType>(schema: S, value: unknown): Shaped<z.infer<S>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  if (issue?.code === "unrecognized_keys") {
    const key = issue.keys[0] ?? "";
    return { ok: false, error: { code: "unsupported_parameter", param: path ? `${path}.${key}` : key, message: "Unsupported parameter." } };
  }
  return { ok: false, error: { code: "invalid_request", param: path || null, message: issue?.message ?? "Invalid request." } };
}

function fail(code: HttpErrorCode, param: string | null, message: string): Prepared {
  return { ok: false, error: { code, param, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
