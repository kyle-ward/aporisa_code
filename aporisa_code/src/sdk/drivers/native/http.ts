// HTTP + SSE transport of the native driver (docs/protocol.md §3.2).
import {
  ErrorBody,
  InputTokensResult,
  Model,
  ModelList,
  type HttpCreateRequest,
  type InputTokensRequest,
} from "../../../protocol/index.ts";
import {
  AporisaAbortError,
  AporisaApiError,
  AporisaProtocolError,
  AporisaTransportError,
} from "../../errors.ts";
import { decodeSse, sseToJson } from "../../sse.ts";
import { resolveApiKey, type ApiKey } from "../../types.ts";

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: ApiKey;
  fetch?: typeof fetch;
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly apiKey: ApiKey;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Origin without the `/v1` suffix, for health endpoints. */
  get origin(): string {
    return this.baseUrl.replace(/\/v1$/, "");
  }

  async listModels(signal?: AbortSignal): Promise<Model[]> {
    const body = await this.json("GET", "/models", undefined, signal);
    return parseOrThrow(ModelList, body, "model list").data;
  }

  async getModel(model: string, signal?: AbortSignal): Promise<Model> {
    const body = await this.json("GET", `/models/${encodeURIComponent(model)}`, undefined, signal);
    return parseOrThrow(Model, body, "model");
  }

  async countInputTokens(request: InputTokensRequest, signal?: AbortSignal) {
    const body = await this.json("POST", "/responses/input_tokens", request, signal);
    return parseOrThrow(InputTokensResult, body, "input token count");
  }

  async health(signal?: AbortSignal): Promise<{ live: boolean; ready: boolean }> {
    const probe = async (path: string) => {
      try {
        const response = await this.fetchImpl(`${this.origin}${path}`, { signal: signal ?? null });
        await response.body?.cancel();
        return response.ok;
      } catch (error) {
        if (signal?.aborted) throw new AporisaAbortError();
        void error;
        return false;
      }
    };
    return { live: await probe("/health/live"), ready: await probe("/health/ready") };
  }

  /** Opens the SSE stream; resolves once the server accepted the request (HTTP 200). */
  async openStream(request: HttpCreateRequest, signal?: AbortSignal): Promise<AsyncGenerator<unknown>> {
    const response = await this.send("POST", "/responses", request, signal, "text/event-stream");
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      throw new AporisaProtocolError("expected a text/event-stream response");
    }
    const body = response.body;
    if (!body) throw new AporisaProtocolError("response has no body");
    return streamEvents(body, signal);
  }

  private async json(method: string, path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.send(method, path, payload, signal, "application/json");
    try {
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw new AporisaAbortError();
      throw new AporisaProtocolError(`response is not valid JSON: ${String(error)}`);
    }
  }

  private async send(
    method: string,
    path: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    accept: string,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await resolveApiKey(this.apiKey)}`,
          accept,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        body: payload === undefined ? null : JSON.stringify(payload),
        signal: signal ?? null,
      });
    } catch (error) {
      if (signal?.aborted) throw new AporisaAbortError();
      throw new AporisaTransportError(`request failed: ${String(error)}`);
    }
    if (!response.ok) throw await apiErrorFrom(response);
    return response;
  }
}

async function* streamEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  try {
    for await (const message of decodeSse(body)) yield sseToJson(message);
  } catch (error) {
    if (signal?.aborted) throw new AporisaAbortError();
    if (error instanceof AporisaProtocolError) throw error;
    throw new AporisaTransportError(`stream interrupted: ${String(error)}`);
  } finally {
    await body.cancel().catch(() => undefined);
  }
}

async function apiErrorFrom(response: Response): Promise<AporisaApiError> {
  let parsed: ErrorBody | null = null;
  try {
    const candidate = ErrorBody.safeParse(await response.json());
    if (candidate.success) parsed = candidate.data;
  } catch {
    // fall through to the protocol error below
  }
  if (!parsed) {
    throw new AporisaProtocolError(`HTTP ${response.status} without a protocol error body`);
  }
  return new AporisaApiError({
    status: response.status,
    ...parsed.error,
    retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
  });
}

export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return seconds > 0 ? seconds : null;
}

function parseOrThrow<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AporisaProtocolError(`invalid ${what} payload`);
  return parsed.data;
}
