// Stub driver: an in-process AporisaClient that runs MockEngine directly (no sockets).
// Implements the full interface C, so harness tests are never limited by a weaker backend.
import { requestViolation, ResponseParams, type Model } from "../protocol/index.ts";
import {
  AporisaApiError,
  AporisaRequestError,
  ResponseStream,
  toCapabilities,
  type AporisaClient,
  type CallOptions,
  type Capabilities,
  type HealthStatus,
  type InputTokenCount,
} from "../sdk/index.ts";
import { MockEngine, type MockScript } from "./engine.ts";
import { mockModel } from "./model.ts";

export interface StubDriverOptions {
  model?: Model;
  script?: MockScript;
  chunkSize?: number;
}

export class StubDriver implements AporisaClient {
  readonly driver = "stub" as const;
  readonly engine: MockEngine;
  /** Full request parameters of every generation, for assertions in tests. */
  readonly requests: ResponseParams[] = [];

  constructor(options: StubDriverOptions = {}) {
    this.engine = new MockEngine({
      model: options.model ?? mockModel(),
      ...(options.script ? { script: options.script } : {}),
      ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
    });
  }

  get model(): Model {
    return this.engine.model;
  }

  async listModels(): Promise<Model[]> {
    return [this.model];
  }

  async getModel(model: string): Promise<Model> {
    if (model !== this.model.id) {
      throw new AporisaApiError({ status: 404, type: "invalid_request_error", code: "model_not_found", message: "Unknown model.", param: "model" });
    }
    return this.model;
  }

  async capabilities(model: string): Promise<Capabilities> {
    return toCapabilities((await this.getModel(model)).capabilities);
  }

  createResponse(params: ResponseParams, options?: CallOptions): ResponseStream {
    return new ResponseStream(
      async () => {
        const checked = await this.check(params);
        this.requests.push(checked);
        let interrupted = false;
        const events = this.engine.run(checked, {
          ...(options?.signal ? { signal: options.signal } : {}),
          interrupted: () => interrupted,
        });
        return {
          events,
          interrupt: () => {
            interrupted = true;
          },
        };
      },
      { prewarm: params.generate === false },
    );
  }

  async countInputTokens(params: ResponseParams): Promise<InputTokenCount> {
    const checked = await this.check(params);
    return { object: "response.input_tokens", input_tokens: this.engine.inputTokens(checked), estimated: false };
  }

  async health(): Promise<HealthStatus> {
    return { live: true, ready: true };
  }

  async close(): Promise<void> {}

  private async check(params: ResponseParams): Promise<ResponseParams> {
    const parsed = ResponseParams.safeParse(params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const code = issue?.code === "unrecognized_keys" ? "unsupported_parameter" : "invalid_request";
      throw new AporisaRequestError(code, issue?.path.join(".") || null, issue?.message ?? "Invalid request.");
    }
    const model = await this.getModel(parsed.data.model);
    const violation = requestViolation(parsed.data, model);
    if (violation) throw new AporisaRequestError(violation.code, violation.param, violation.message);
    if (this.engine.exceedsContext(parsed.data)) {
      throw new AporisaApiError({ status: 400, type: "invalid_request_error", code: "context_length_exceeded", message: "Input exceeds the model context window.", param: "input" });
    }
    return parsed.data;
  }
}
