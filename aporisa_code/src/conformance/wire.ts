// Wire-level conformance suite (docs/protocol.md). Speaks raw HTTP/SSE and WebSocket, not
// the SDK, so the same cases judge the mock server now and the real backend later.
// Cases only assume behaviour every compliant server must show, whatever the model says.
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import WebSocket from "ws";
import {
  ErrorBody,
  InputTokensResult,
  isTerminalEvent,
  Model,
  ModelList,
  schemaValueViolation,
  StreamEvent,
  StreamValidator,
  WsErrorMessage,
  type CapabilityName,
  type HttpErrorCode,
  type InputItem,
  type ResponseObject,
} from "../protocol/index.ts";
import { decodeSse, sseToJson } from "../sdk/sse.ts";

export interface WireTarget {
  /** Base URL ending in /v1. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface WireContext {
  target: WireTarget;
  model: Model;
}

export interface WireCase {
  id: string;
  title: string;
  /** Capabilities the case needs; it is skipped when any of them is not declared. */
  requires?: CapabilityName | readonly CapabilityName[];
  run(context: WireContext): Promise<void>;
}

/** The first required capability the model does not declare, if any. */
export function missingCapability(testCase: WireCase, model: Model): CapabilityName | undefined {
  const required = testCase.requires === undefined ? [] : [testCase.requires].flat();
  return required.find((name) => !model.capabilities[name]);
}

// --- helpers -------------------------------------------------------------------------------

const origin = (target: WireTarget) => target.baseUrl.replace(/\/v1\/?$/, "");
const auth = (target: WireTarget) => ({ authorization: `Bearer ${target.apiKey}` });

export function userMessage(text: string): InputItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

const CONTINUATION_SETUP_TOKENS = 2048;
const STRUCTURED_OUTPUT_TOKENS = 1024;

/** The lightest effort the model accepts: structured cases test the answer, not reasoning. */
function lightestEffort(context: WireContext): string {
  const efforts = context.model.reasoning.supported_efforts;
  return efforts.includes("none") ? "none" : (efforts[0] ?? context.model.reasoning.default_effort);
}

const CITY_SCHEMA = {
  type: "object",
  properties: {
    city: { type: "string" },
    population: { type: "integer" },
    capital: { type: "boolean" },
    languages: { type: "array", items: { type: "string" } },
    size: { type: "string", enum: ["small", "medium", "large"] },
    mayor: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["city", "population", "capital", "languages", "size", "mayor"],
  additionalProperties: false,
};

/** A complete RGB PNG of one colour with a white band on the left, as a data URL. */
export function pngDataUrl(width: number, height: number, rgb: readonly [number, number, number]): string {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = x < width / 4 ? [255, 255, 255] : rgb;
      raw.set(color, y * row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${file.toString("base64")}`;
}

function imageMessage(text: string, imageUrl: string): InputItem {
  return {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text },
      { type: "input_image", image_url: imageUrl },
    ],
  };
}

const supportsImages = (context: WireContext) => context.model.input_modalities.includes("image");
const RED = [200, 40, 40] as const;
const BLUE = [40, 60, 200] as const;

function baseRequest(context: WireContext, text = "Reply with one short sentence.") {
  return { model: context.target.model, input: [userMessage(text)], max_output_tokens: 256 };
}

async function http(
  target: WireTarget,
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string>; auth?: boolean } = {},
): Promise<Response> {
  return fetch(`${target.baseUrl}${path}`, {
    method,
    headers: {
      ...(options.auth === false ? {} : auth(target)),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ?? null,
  });
}

async function expectError(response: Response, status: number, code: HttpErrorCode): Promise<void> {
  const text = await response.text();
  assert.equal(response.status, status, `expected HTTP ${status} ${code}, got ${response.status}: ${text}`);
  const body = ErrorBody.safeParse(JSON.parse(text));
  assert.ok(body.success, `error body does not match the protocol: ${text}`);
  assert.equal(body.data.error.code, code, `expected ${code}, got: ${text}`);
}

/** Posts a streaming request and validates every event against §7.3. */
export async function streamHttp(
  target: WireTarget,
  request: Record<string, unknown>,
): Promise<{ events: StreamEvent[]; response: ResponseObject; headers: Headers }> {
  const response = await http(target, "POST", "/responses", { body: JSON.stringify({ ...request, stream: true }) });
  if (!response.ok) assert.fail(`stream request failed with HTTP ${response.status}: ${await response.text()}`);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const validator = new StreamValidator({ prewarm: request.generate === false });
  const events: StreamEvent[] = [];
  assert.ok(response.body, "stream has no body");
  for await (const message of decodeSse(response.body)) {
    const event = StreamEvent.parse(sseToJson(message));
    validator.accept(event);
    events.push(event);
  }
  assert.ok(validator.terminal, "stream ended without a terminal event");
  return { events, response: validator.terminal, headers: response.headers };
}

interface WsSession {
  socket: WebSocket;
  next(): Promise<unknown>;
  send(message: unknown): void;
  close(): void;
}

export async function openWs(target: WireTarget, withAuth = true): Promise<WsSession> {
  const url = `${target.baseUrl.replace(/^http/, "ws")}/responses`;
  const socket = new WebSocket(url, { headers: withAuth ? auth(target) : {}, perMessageDeflate: false });
  const inbox: unknown[] = [];
  const waiters: ((value: unknown) => void)[] = [];
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString()) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else inbox.push(value);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) => reject(new Error(`upgrade rejected: ${response.statusCode}`)));
    socket.once("error", reject);
  });
  return {
    socket,
    send: (message) => socket.send(JSON.stringify(message)),
    next: () =>
      new Promise((resolve, reject) => {
        const queued = inbox.shift();
        if (queued !== undefined) return resolve(queued);
        const timer = setTimeout(() => reject(new Error("timed out waiting for a WebSocket message")), 30_000);
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }),
    close: () => socket.close(),
  };
}

/** Reads one response from a WebSocket session, validating every event. */
async function readWsResponse(
  session: WsSession,
  options: { prewarm?: boolean; onEvent?: (event: StreamEvent) => void } = {},
): Promise<ResponseObject> {
  const validator = new StreamValidator({ prewarm: options.prewarm ?? false });
  for (;;) {
    const raw = await session.next();
    const error = WsErrorMessage.safeParse(raw);
    if (error.success) assert.fail(`unexpected error message: ${JSON.stringify(raw)}`);
    const event = StreamEvent.parse(raw);
    validator.accept(event);
    options.onEvent?.(event);
    if (isTerminalEvent(event)) return event.response;
  }
}

async function expectWsError(session: WsSession, code: HttpErrorCode): Promise<void> {
  const raw = await session.next();
  const parsed = WsErrorMessage.safeParse(raw);
  assert.ok(parsed.success, `expected an error message, got ${JSON.stringify(raw)}`);
  assert.equal(parsed.data.error.code, code);
}

// --- cases ----------------------------------------------------------------------------------

export const wireCases: WireCase[] = [
  {
    id: "W01",
    title: "health endpoints answer without authentication",
    async run({ target }) {
      const live = await fetch(`${origin(target)}/health/live`);
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { status: "alive" });
      const ready = await fetch(`${origin(target)}/health/ready`);
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: "ready" });
    },
  },
  {
    id: "W02",
    title: "model list and model lookup follow §5",
    async run({ target }) {
      const list = ModelList.parse(await (await http(target, "GET", "/models")).json());
      assert.ok(list.data.some((model) => model.id === target.model));
      Model.parse(await (await http(target, "GET", `/models/${target.model}`)).json());
      await expectError(await http(target, "GET", "/models/no-such-model"), 404, "model_not_found");
    },
  },
  {
    id: "W03",
    title: "Bearer authentication is required",
    async run({ target }) {
      await expectError(await http(target, "GET", "/models", { auth: false }), 401, "invalid_api_key");
      await expectError(
        await http(target, "GET", "/models", { headers: { authorization: "Bearer wrong-key" } }),
        401,
        "invalid_api_key",
      );
    },
  },
  {
    id: "W04",
    title: "unknown endpoints return not_found",
    async run({ target }) {
      await expectError(await http(target, "GET", "/no-such-endpoint"), 404, "not_found");
    },
  },
  {
    id: "W05",
    title: "non-JSON bodies are rejected with 415",
    async run(context) {
      const response = await http(context.target, "POST", "/responses", {
        body: JSON.stringify({ ...baseRequest(context), stream: true }),
        headers: { "content-type": "text/plain" },
      });
      await expectError(response, 415, "unsupported_media_type");
    },
  },
  {
    id: "W06",
    title: "duplicate JSON keys are rejected",
    async run(context) {
      const body = `{"model":${JSON.stringify(context.target.model)},"model":${JSON.stringify(context.target.model)},"input":[],"stream":true}`;
      await expectError(await http(context.target, "POST", "/responses", { body }), 400, "invalid_request");
    },
  },
  {
    id: "W07",
    title: "unknown request keys are rejected as unsupported_parameter",
    async run(context) {
      const body = JSON.stringify({ ...baseRequest(context), stream: true, temperature: 0.2 });
      await expectError(await http(context.target, "POST", "/responses", { body }), 400, "unsupported_parameter");
    },
  },
  {
    id: "W08",
    title: "previous_response_id is rejected over HTTP",
    async run(context) {
      const body = JSON.stringify({ ...baseRequest(context), stream: true, previous_response_id: "resp_x" });
      await expectError(await http(context.target, "POST", "/responses", { body }), 400, "unsupported_parameter");
    },
  },
  {
    id: "W09",
    title: "stream must be true",
    async run(context) {
      const body = JSON.stringify({ ...baseRequest(context), stream: false });
      await expectError(await http(context.target, "POST", "/responses", { body }), 400, "invalid_request");
    },
  },
  {
    id: "W10",
    title: "tool outputs must follow a matching call",
    async run(context) {
      const body = JSON.stringify({
        ...baseRequest(context),
        stream: true,
        input: [userMessage("hi"), { type: "function_call_output", call_id: "call_missing", output: "x" }],
      });
      await expectError(await http(context.target, "POST", "/responses", { body }), 400, "invalid_request");
    },
  },
  {
    id: "W11",
    title: "schemas outside the portable subset are rejected",
    async run(context) {
      const body = JSON.stringify({
        ...baseRequest(context),
        stream: true,
        tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string", pattern: "^a" } } } }],
      });
      await expectError(await http(context.target, "POST", "/responses", { body }), 400, "unsupported_schema");
    },
  },
  {
    id: "W12",
    title: "oversized input fails with context_length_exceeded before streaming",
    async run(context) {
      const text = "a ".repeat(context.model.context_window * 4);
      const body = JSON.stringify({ ...baseRequest(context, text), stream: true });
      await expectError(await http(context.target, "POST", "/responses", { body }), 400, "context_length_exceeded");
    },
  },
  {
    id: "W13",
    title: "a basic SSE stream obeys §7.3 and reports usage",
    async run(context) {
      const { response, headers } = await streamHttp(context.target, baseRequest(context));
      assert.equal(headers.get("cache-control"), "no-store");
      assert.ok(response.status === "completed" || response.status === "incomplete");
      assert.ok(response.usage && response.usage.input_tokens > 0);
      assert.equal(response.model, context.target.model);
    },
  },
  {
    id: "W14",
    title: "prewarm (generate:false) completes without output",
    requires: "prewarm",
    async run(context) {
      const { events, response } = await streamHttp(context.target, { ...baseRequest(context), generate: false });
      assert.equal(events.length, 2);
      assert.equal(response.status, "completed");
      assert.equal(response.usage?.output_tokens, 0);
    },
  },
  {
    id: "W15",
    title: "input_tokens matches the usage of a real request",
    requires: "input_tokens",
    async run(context) {
      const request = baseRequest(context);
      const counted = InputTokensResult.parse(
        await (await http(context.target, "POST", "/responses/input_tokens", { body: JSON.stringify(request) })).json(),
      );
      const { response } = await streamHttp(context.target, request);
      assert.equal(counted.input_tokens, response.usage?.input_tokens);
    },
  },
  {
    id: "W16",
    title: "prompt_cache_key reuse reports cached_tokens",
    requires: "prompt_cache",
    async run(context) {
      const request = { ...baseRequest(context), prompt_cache_key: `conformance-${Date.now()}` };
      await streamHttp(context.target, request);
      const { response } = await streamHttp(context.target, request);
      assert.ok((response.usage?.input_tokens_details.cached_tokens ?? 0) > 0, "second request reused no prefix");
    },
  },
  {
    id: "W17",
    title: "WebSocket upgrade requires authentication",
    requires: "websocket",
    async run({ target }) {
      await assert.rejects(openWs(target, false), /upgrade rejected: 401/);
    },
  },
  {
    id: "W18",
    title: "WebSocket response.create streams the same events as SSE",
    requires: "websocket",
    async run(context) {
      const session = await openWs(context.target);
      try {
        session.send({ type: "response.create", ...baseRequest(context) });
        const response = await readWsResponse(session);
        assert.ok(response.status === "completed" || response.status === "incomplete");
      } finally {
        session.close();
      }
    },
  },
  {
    id: "W19",
    title: "WebSocket incremental continuation and its failure modes",
    requires: "websocket",
    async run(context) {
      const session = await openWs(context.target);
      try {
        // A real model reasons before answering; give the setup response room to complete.
        const first = { ...baseRequest(context), max_output_tokens: CONTINUATION_SETUP_TOKENS };
        session.send({ type: "response.create", ...first });
        const previous = await readWsResponse(session);
        assert.equal(previous.status, "completed", "continuation needs a completed response");

        session.send({ type: "response.create", ...first, input: [], previous_response_id: "resp_unknown" });
        await expectWsError(session, "previous_response_not_found");

        session.send({ type: "response.create", ...first, max_output_tokens: 128, input: [userMessage("again")], previous_response_id: previous.id });
        await expectWsError(session, "previous_response_not_found");

        session.send({ type: "response.create", ...first, input: [userMessage("One more sentence.")], previous_response_id: previous.id });
        const next = await readWsResponse(session);
        assert.ok(next.usage && next.usage.input_tokens > (previous.usage?.input_tokens ?? 0));
      } finally {
        session.close();
      }
    },
  },
  {
    id: "W20",
    title: "a second create during an active response is rejected",
    requires: "websocket",
    async run(context) {
      const session = await openWs(context.target);
      try {
        const request = { type: "response.create", ...baseRequest(context, "Count from 1 to 200, one number per line.") };
        session.send(request);
        session.send(request);
        let sawBusy = false;
        let terminal = false;
        const validator = new StreamValidator();
        while (!terminal || !sawBusy) {
          const raw = await session.next();
          const error = WsErrorMessage.safeParse(raw);
          if (error.success) {
            assert.equal(error.data.error.code, "response_in_progress");
            sawBusy = true;
            continue;
          }
          const event = StreamEvent.parse(raw);
          validator.accept(event);
          terminal = isTerminalEvent(event);
          if (terminal && !sawBusy) assert.fail("the second create was not rejected");
        }
      } finally {
        session.close();
      }
    },
  },
  {
    id: "W21",
    title: "response.interrupt ends the response as interrupted",
    requires: "websocket",
    async run(context) {
      const session = await openWs(context.target);
      try {
        session.send({ type: "response.create", ...baseRequest(context, "Count from 1 to 200, one number per line.") });
        const response = await readWsResponse(session, {
          onEvent: (event) => {
            if (event.type === "response.created") {
              session.send({ type: "response.interrupt", response_id: event.response.id });
            }
          },
        });
        // The model may finish before the interrupt lands; otherwise the reason must be interrupted.
        if (response.status === "incomplete") assert.equal(response.incomplete_details?.reason, "interrupted");
        else assert.equal(response.status, "completed");
      } finally {
        session.close();
      }
    },
  },
  {
    id: "W22",
    title: "invalid WebSocket messages yield error messages and keep the connection usable",
    requires: "websocket",
    async run(context) {
      const session = await openWs(context.target);
      try {
        session.socket.send("{not json");
        await expectWsError(session, "invalid_request");
        session.send({ type: "response.unknown" });
        await expectWsError(session, "invalid_request");
        session.send({ type: "response.create", ...baseRequest(context), stream: true });
        await expectWsError(session, "unsupported_parameter");
        session.send({ type: "response.create", ...baseRequest(context) });
        await readWsResponse(session);
      } finally {
        session.close();
      }
    },
  },
  {
    id: "W23",
    title: "configuration_update follows the capability, position and effort rules of §6.1",
    async run(context) {
      const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
      const post = (input: unknown[]) =>
        http(context.target, "POST", "/responses", { body: JSON.stringify({ ...baseRequest(context), stream: true, input }) });
      if (!context.model.capabilities.reasoning_effort_updates) {
        await expectError(await post([userMessage("hi"), update(context.model.reasoning.default_effort)]), 400, "unsupported_parameter");
        return;
      }
      const call = { type: "function_call", call_id: "call_w23", name: "lookup", arguments: "{}" };
      const output = { type: "function_call_output", call_id: "call_w23", output: "x" };
      await expectError(await post([userMessage("hi"), call, update(context.model.reasoning.default_effort), output]), 400, "invalid_request");
      const unsupported = (["none", "low", "medium", "high"] as const).find(
        (effort) => !context.model.reasoning.supported_efforts.includes(effort),
      );
      if (unsupported) await expectError(await post([userMessage("hi"), update(unsupported)]), 400, "unsupported_parameter");

      const efforts = context.model.reasoning.supported_efforts;
      const target = efforts.includes("none") ? "none" : context.model.reasoning.default_effort;
      const baseline = efforts.find((effort) => effort !== target) ?? target;
      const { response } = await streamHttp(context.target, {
        ...baseRequest(context),
        reasoning: { effort: baseline },
        input: [userMessage("hi"), call, output, update(target)],
      });
      assert.ok(response.status === "completed" || response.status === "incomplete");
      if (target === "none") {
        assert.ok(response.output.every((item) => item.type !== "reasoning"), "effort none produced a reasoning item");
        assert.equal(response.usage?.output_tokens_details.reasoning_tokens, 0);
      }
    },
  },
  {
    id: "W24",
    title: "a configuration_update in the incremental input keeps WebSocket continuation",
    requires: ["websocket", "reasoning_effort_updates"],
    async run(context) {
      const session = await openWs(context.target);
      try {
        // A real model reasons before answering; give the setup response room to complete.
        const first = { ...baseRequest(context), max_output_tokens: CONTINUATION_SETUP_TOKENS };
        session.send({ type: "response.create", ...first });
        const previous = await readWsResponse(session);
        assert.equal(previous.status, "completed", "continuation needs a completed response");
        const effort = context.model.reasoning.supported_efforts.at(-1) ?? context.model.reasoning.default_effort;
        session.send({
          type: "response.create",
          ...first,
          input: [{ type: "configuration_update", reasoning: { effort } }, userMessage("One more sentence.")],
          previous_response_id: previous.id,
        });
        const next = await readWsResponse(session);
        assert.ok(next.status === "completed" || next.status === "incomplete");
      } finally {
        session.close();
      }
    },
  },
  {
    id: "W25",
    title: "text.format makes the answer one JSON value of the schema (§8.4)",
    requires: "structured_output",
    async run(context) {
      const { response } = await streamHttp(context.target, {
        ...baseRequest(context, "Describe the city of Paris as a JSON object."),
        max_output_tokens: STRUCTURED_OUTPUT_TOKENS,
        reasoning: { effort: lightestEffort(context) },
        text: { format: { type: "json_schema", name: "city", schema: CITY_SCHEMA, strict: true } },
      });
      assert.equal(response.status, "completed", `status ${response.status}`);
      const messages = response.output.filter((item) => item.type === "message");
      assert.equal(messages.length, 1, "text.format allows exactly one answer message");
      const [message] = messages;
      assert.ok(message?.type === "message");
      if (message.phase !== undefined) assert.equal(message.phase, "final_answer");
      const text = message.content.map((part) => (part.type === "output_text" ? part.text : "")).join("");
      let value: unknown;
      assert.doesNotThrow(() => {
        value = JSON.parse(text);
      }, "the answer is not JSON");
      assert.equal(schemaValueViolation(value, CITY_SCHEMA), null);
    },
  },
  {
    id: "W26",
    title: "arguments of a strict tool follow its schema (§8.4)",
    requires: "structured_output",
    async run(context) {
      const { response } = await streamHttp(context.target, {
        ...baseRequest(
          context,
          "Call the record_city tool for Paris, population 2100000, capital true, languages French, " +
            "size large, mayor unknown (null). Call the tool; do not answer in text.",
        ),
        max_output_tokens: STRUCTURED_OUTPUT_TOKENS,
        reasoning: { effort: lightestEffort(context) },
        tools: [
          { type: "function", name: "record_city", description: "Record facts about a city.", parameters: CITY_SCHEMA, strict: true },
        ],
      });
      assert.equal(response.status, "completed", `status ${response.status}`);
      // A model cannot be forced to call; every call it makes must conform.
      for (const item of response.output) {
        if (item.type !== "function_call" || item.name !== "record_city") continue;
        assert.equal(schemaValueViolation(JSON.parse(item.arguments), CITY_SCHEMA), null);
      }
    },
  },
  {
    id: "W27",
    title: "input images are accepted when the model declares them and counted as input (§7.1)",
    async run(context) {
      const question = "What colour is this image? Answer in one word.";
      const request = {
        ...baseRequest(context),
        input: [imageMessage(question, pngDataUrl(256, 256, RED))],
        max_output_tokens: 64,
        reasoning: { effort: lightestEffort(context) },
      };
      if (!supportsImages(context)) {
        const body = JSON.stringify({ ...request, stream: true });
        await expectError(await http(context.target, "POST", "/responses", { body }), 400, "unsupported_parameter");
        return;
      }
      const { response } = await streamHttp(context.target, request);
      assert.notEqual(response.status, "failed", `failed: ${JSON.stringify(response.error)}`);
      const { response: plain } = await streamHttp(context.target, { ...request, input: [userMessage(question)] });
      const withImage = response.usage?.input_tokens ?? 0;
      assert.ok(withImage > (plain.usage?.input_tokens ?? 0), "the image adds no input tokens");
      if (context.model.capabilities.input_tokens) {
        const { stream: _stream, ...countable } = { ...request, stream: undefined };
        const counted = await http(context.target, "POST", "/responses/input_tokens", { body: JSON.stringify(countable) });
        assert.equal(counted.status, 200);
        assert.equal(InputTokensResult.parse(await counted.json()).input_tokens, withImage);
      }
    },
  },
  {
    id: "W28",
    title: "an image in a tool output is accepted (§7.1)",
    async run(context) {
      if (!supportsImages(context)) return;
      const call = { type: "function_call", call_id: "call_shot", name: "take_screenshot", arguments: "{}" } as const;
      const output: InputItem = {
        type: "function_call_output",
        call_id: "call_shot",
        output: [
          { type: "input_text", text: "Screenshot:" },
          { type: "input_image", image_url: pngDataUrl(320, 192, BLUE) },
        ],
      };
      const { response } = await streamHttp(context.target, {
        ...baseRequest(context, "Take a screenshot and tell me its main colour."),
        input: [userMessage("Take a screenshot and tell me its main colour."), call, output],
        tools: [{ type: "function", name: "take_screenshot", description: "Capture the screen.", parameters: { type: "object", properties: {} } }],
        tool_choice: "none",
        max_output_tokens: 64,
        reasoning: { effort: lightestEffort(context) },
      });
      assert.notEqual(response.status, "failed", `failed: ${JSON.stringify(response.error)}`);
    },
  },
  {
    id: "W29",
    title: "an image that is not a complete PNG or JPEG of its declared type is rejected (§7.1)",
    async run(context) {
      if (!supportsImages(context)) return;
      const valid = pngDataUrl(64, 64, RED);
      const bytes = Buffer.from(valid.slice(valid.indexOf(",") + 1), "base64");
      const broken = [
        `data:image/png;base64,${Buffer.from("not an image at all, just text").toString("base64")}`,
        `data:image/jpeg;base64,${bytes.toString("base64")}`, // PNG bytes declared as JPEG
        `data:image/png;base64,${bytes.subarray(0, bytes.length - 20).toString("base64")}`, // cut short
      ];
      for (const imageUrl of broken) {
        const body = JSON.stringify({ ...baseRequest(context), input: [imageMessage("Describe it.", imageUrl)], stream: true });
        await expectError(await http(context.target, "POST", "/responses", { body }), 400, "invalid_image");
      }
    },
  },
  {
    id: "W30",
    title: "the prefix cache tells two images of the same size apart (§7.1, X1)",
    requires: "prompt_cache",
    async run(context) {
      if (!supportsImages(context)) return;
      const key = `wire-images-${Date.now()}`;
      const ask = (rgb: readonly [number, number, number]) =>
        streamHttp(context.target, {
          ...baseRequest(context),
          input: [imageMessage("What colour is this image? Answer in one word.", pngDataUrl(256, 256, rgb))],
          max_output_tokens: 16,
          reasoning: { effort: lightestEffort(context) },
          prompt_cache_key: key,
        });
      await ask(RED);
      const again = (await ask(RED)).response.usage;
      assert.ok(again, "no usage");
      assert.equal(again.input_tokens_details.cached_tokens, again.input_tokens, "the same request was not fully cached");
      const other = (await ask(BLUE)).response.usage;
      assert.ok(other, "no usage");
      assert.ok(other.input_tokens_details.cached_tokens < other.input_tokens, "a different image reused the cached image");
    },
  },
];

/** Runs every applicable case; returns per-case results for CLI reporting. */
export async function runWireConformance(target: WireTarget): Promise<{ id: string; title: string; status: "pass" | "fail" | "skip"; detail?: string }[]> {
  const model = Model.parse(await (await http(target, "GET", `/models/${target.model}`)).json());
  const results = [];
  for (const testCase of wireCases) {
    const missing = missingCapability(testCase, model);
    if (missing) {
      results.push({ id: testCase.id, title: testCase.title, status: "skip" as const, detail: `requires ${missing}` });
      continue;
    }
    try {
      await testCase.run({ target, model });
      results.push({ id: testCase.id, title: testCase.title, status: "pass" as const });
    } catch (error) {
      results.push({ id: testCase.id, title: testCase.title, status: "fail" as const, detail: String(error) });
    }
  }
  return results;
}
