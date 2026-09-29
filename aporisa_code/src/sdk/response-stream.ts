// A single-consumer stream of validated protocol events with a terminal result.
import {
  isTerminalEvent,
  StreamEvent,
  StreamValidator,
  StreamViolation,
  type ResponseObject,
} from "../protocol/index.ts";
import { AporisaProtocolError } from "./errors.ts";

export interface ResponseStreamSource {
  /** Raw decoded event payloads (JSON values) in arrival order. */
  events: AsyncIterable<unknown>;
  /** Graceful interrupt (WebSocket `response.interrupt`); absent when unsupported. */
  interrupt?: (responseId: string) => void;
  /** Called once when the stream has finished, successfully or not. */
  onFinish?: (terminal: ResponseObject | null) => void;
}

export interface ResponseStreamOptions {
  prewarm?: boolean;
}

/**
 * Iterate it once (`for await`), or call `final()` directly. Each event is schema-checked
 * and ordering-checked (docs/protocol.md §7.3); violations raise AporisaProtocolError.
 */
export class ResponseStream implements AsyncIterable<StreamEvent> {
  private readonly validator: StreamValidator;
  private readonly source: () => Promise<ResponseStreamSource>;
  private resolved: ResponseStreamSource | null = null;
  private started = false;
  private interruptRequested = false;
  private readonly terminal: Promise<ResponseObject>;
  private resolveTerminal!: (response: ResponseObject) => void;
  private rejectTerminal!: (error: unknown) => void;

  constructor(source: () => Promise<ResponseStreamSource>, options: ResponseStreamOptions = {}) {
    this.source = source;
    this.validator = new StreamValidator({ prewarm: options.prewarm ?? false });
    this.terminal = new Promise<ResponseObject>((resolve, reject) => {
      this.resolveTerminal = resolve;
      this.rejectTerminal = reject;
    });
    // Consumers may never call final(); avoid unhandled-rejection noise.
    this.terminal.catch(() => undefined);
  }

  /** Response id once response.created has arrived. */
  get responseId(): string | null {
    return this.validator.responseId;
  }

  /**
   * Asks the server to stop gracefully; the stream then ends with response.incomplete
   * (reason `interrupted`). Only WebSocket supports this; on HTTP use an AbortSignal.
   */
  interrupt(): boolean {
    this.interruptRequested = true;
    return this.tryInterrupt();
  }

  get supportsInterrupt(): boolean {
    return this.resolved?.interrupt !== undefined;
  }

  private tryInterrupt(): boolean {
    const id = this.validator.responseId;
    const interrupt = this.resolved?.interrupt;
    if (!id || !interrupt || this.validator.terminal) return false;
    interrupt(id);
    return true;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (this.started) throw new Error("ResponseStream can only be consumed once");
    this.started = true;
    let finished: ResponseObject | null = null;
    try {
      const source = await this.source();
      this.resolved = source;
      try {
        for await (const raw of source.events) {
          const event = this.check(raw);
          if (event.type === "response.created" && this.interruptRequested) this.tryInterrupt();
          yield event;
          if (isTerminalEvent(event)) {
            finished = event.response;
            break;
          }
        }
        if (!finished) throw new AporisaProtocolError("stream ended without a terminal event");
        this.resolveTerminal(finished);
      } finally {
        source.onFinish?.(finished);
      }
    } catch (error) {
      this.rejectTerminal(error);
      throw error;
    }
  }

  /** Consumes the remaining events (if nobody else is) and returns the terminal response. */
  async final(): Promise<ResponseObject> {
    if (!this.started) {
      for await (const _event of this) {
        // drain
      }
    }
    return this.terminal;
  }

  private check(raw: unknown): StreamEvent {
    const parsed = StreamEvent.safeParse(raw);
    if (!parsed.success) {
      throw new AporisaProtocolError(`invalid stream event: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
    }
    try {
      this.validator.accept(parsed.data);
    } catch (error) {
      if (error instanceof StreamViolation) throw new AporisaProtocolError(error.message);
      throw error;
    }
    return parsed.data;
  }
}
