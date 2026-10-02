// Native driver: talks the Aporisa protocol to the project's own backend. WebSocket by
// default with a sticky per-client fallback to HTTP, following codex `force_http_fallback`.
import {
  canonicalJson,
  requestViolation,
  ResponseParams,
  type Model,
  type WireCapabilities,
} from "../../../protocol/index.ts";
import { AporisaRequestError } from "../../errors.ts";
import { ResponseStream, type ResponseStreamSource } from "../../response-stream.ts";
import { defaultSleep, withPreStreamRetry, type RetryPolicy } from "../../retry.ts";
import type {
  ApiKey,
  AporisaClient,
  CallOptions,
  Capabilities,
  Diagnostic,
  HealthStatus,
  InputTokenCount,
  Transport,
} from "../../types.ts";
import { HttpTransport } from "./http.ts";
import { WebSocketTransport, WebSocketUnavailable } from "./websocket.ts";

export interface NativeDriverOptions {
  baseUrl: string;
  /** A fixed key, or a function asked before every request (F4). */
  apiKey: ApiKey;
  /** Preferred transport; WebSocket unless explicitly set to "http". */
  transport?: Transport;
  maxRetries?: number;
  connectTimeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: RetryPolicy["sleep"];
  random?: () => number;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

export class NativeDriver implements AporisaClient {
  readonly driver = "native" as const;
  private readonly http: HttpTransport;
  private readonly ws: WebSocketTransport | null;
  private readonly retry: RetryPolicy;
  private readonly onDiagnostic: ((diagnostic: Diagnostic) => void) | undefined;
  private readonly models = new Map<string, Model>();
  private websocketDisabled: string | null = null;

  constructor(options: NativeDriverOptions) {
    this.onDiagnostic = options.onDiagnostic;
    this.http = new HttpTransport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.ws =
      options.transport === "http"
        ? null
        : new WebSocketTransport({
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            ...(options.connectTimeoutMs !== undefined ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
            ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
            onBroken: (reason) => this.disableWebSocket(reason),
          });
    this.retry = {
      maxRetries: options.maxRetries ?? 2,
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? Math.random,
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    };
  }

  /** The transport the next request will try first. */
  get activeTransport(): Transport {
    return this.ws && !this.websocketDisabled ? "websocket" : "http";
  }

  async listModels(options?: CallOptions): Promise<Model[]> {
    const models = await this.http.listModels(options?.signal);
    for (const model of models) this.models.set(model.id, model);
    return models;
  }

  async getModel(model: string, options?: CallOptions): Promise<Model> {
    const cached = this.models.get(model);
    if (cached) return cached;
    const fetched = await this.http.getModel(model, options?.signal);
    this.models.set(fetched.id, fetched);
    return fetched;
  }

  async capabilities(model: string, options?: CallOptions): Promise<Capabilities> {
    const info = await this.getModel(model, options);
    return toCapabilities(info.capabilities);
  }

  createResponse(params: ResponseParams, options?: CallOptions): ResponseStream {
    return new ResponseStream(() => this.open(params, options?.signal), { prewarm: params.generate === false });
  }

  async countInputTokens(params: ResponseParams, options?: CallOptions): Promise<InputTokenCount> {
    const request = await this.checked(params, options?.signal);
    const model = await this.getModel(request.model, options);
    if (model.capabilities.input_tokens) {
      const { generate: _generate, ...body } = request;
      const result = await this.http.countInputTokens(body, options?.signal);
      return { ...result, estimated: false };
    }
    return { object: "response.input_tokens", input_tokens: estimateTokens(request), estimated: true };
  }

  health(options?: CallOptions): Promise<HealthStatus> {
    return this.http.health(options?.signal);
  }

  async close(): Promise<void> {
    await this.ws?.close();
  }

  private async checked(params: ResponseParams, signal?: AbortSignal): Promise<ResponseParams> {
    const parsed = ResponseParams.safeParse(params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const code = issue?.code === "unrecognized_keys" ? "unsupported_parameter" : "invalid_request";
      throw new AporisaRequestError(code, issue?.path.join(".") || null, issue?.message ?? "Invalid request.");
    }
    const model = await this.getModel(parsed.data.model, signal ? { signal } : undefined);
    const violation = requestViolation(parsed.data, model);
    if (violation) throw new AporisaRequestError(violation.code, violation.param, violation.message);
    return parsed.data;
  }

  private async open(params: ResponseParams, signal?: AbortSignal): Promise<ResponseStreamSource> {
    const request = await this.checked(params, signal);
    const model = await this.getModel(request.model, signal ? { signal } : undefined);
    if (this.ws && !this.websocketDisabled) {
      if (!model.capabilities.websocket) {
        this.disableWebSocket("model does not declare the websocket capability");
      } else {
        const ws = this.ws;
        try {
          const source = await withPreStreamRetry(this.retry, () => ws.start(request, signal), signal);
          if (source) return source;
        } catch (error) {
          if (!(error instanceof WebSocketUnavailable)) throw error;
          this.disableWebSocket(error.message);
        }
      }
    }
    const events = await withPreStreamRetry(
      this.retry,
      () => this.http.openStream({ ...request, stream: true }, signal),
      signal,
    );
    return { events };
  }

  private disableWebSocket(reason: string): void {
    if (this.websocketDisabled) return;
    this.websocketDisabled = reason;
    this.onDiagnostic?.({ kind: "transport_fallback", from: "websocket", to: "http", reason });
    void this.ws?.close();
  }
}

export function toCapabilities(wire: WireCapabilities): Capabilities {
  const result = {} as Capabilities;
  for (const [name, supported] of Object.entries(wire) as [keyof WireCapabilities, boolean][]) {
    result[name] = supported ? "supported" : "unsupported";
  }
  return result;
}

/** codex-style fallback estimate: ~4 bytes per token over the canonical request. */
export function estimateTokens(params: ResponseParams): number {
  const { instructions, tools, input } = params;
  const bytes = Buffer.byteLength(canonicalJson({ instructions, tools, input }), "utf8");
  return Math.ceil(bytes / 4);
}
