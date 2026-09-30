// SDK native driver against the mock server: transports, continuation, fallback,
// interrupt/abort, retries and error taxonomy.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { InputItem, ResponseParams, ToolSpec } from "../src/protocol/index.ts";
import { MockServer, mockModel, type MockServerOptions } from "../src/mock/index.ts";
import {
  AporisaAbortError,
  AporisaApiError,
  AporisaProtocolError,
  AporisaRequestError,
  NativeDriver,
  type Diagnostic,
  type NativeDriverOptions,
} from "../src/sdk/index.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(serverOptions: MockServerOptions = {}, driverOptions: Partial<NativeDriverOptions> = {}) {
  const server = new MockServer({ chunkSize: 4, ...serverOptions });
  const baseUrl = await server.start();
  const diagnostics: Diagnostic[] = [];
  const driver = new NativeDriver({
    baseUrl,
    apiKey: server.apiKey,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...driverOptions,
  });
  cleanups.push(() => server.close(), () => driver.close());
  return { server, driver, diagnostics, baseUrl };
}

const user = (text: string): InputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const tools: ToolSpec[] = [
  { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
];
const request = (input: InputItem[], extra: Partial<ResponseParams> = {}): ResponseParams => ({
  model: mockModel().id,
  input,
  ...extra,
});

describe("native driver: metadata", () => {
  it("lists models and reports tri-state capabilities", async () => {
    const { driver } = await setup({ model: mockModel({ capabilities: { ...mockModel().capabilities, prewarm: false } }) });
    const [model] = await driver.listModels();
    expect(model?.id).toBe(mockModel().id);
    const caps = await driver.capabilities(mockModel().id);
    expect(caps.websocket).toBe("supported");
    expect(caps.prewarm).toBe("unsupported");
    expect(await driver.health()).toEqual({ live: true, ready: true });
  });

  it("maps unknown models to AporisaApiError(model_not_found)", async () => {
    const { driver } = await setup();
    await expect(driver.getModel("nope")).rejects.toMatchObject({ name: "AporisaApiError", code: "model_not_found", status: 404 });
  });
});

describe("native driver: WebSocket (default transport)", () => {
  it("streams over WebSocket by default and yields validated events", async () => {
    const { driver, server } = await setup();
    const stream = driver.createResponse(request([user("hi")]));
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect(types[0]).toBe("response.created");
    expect(types.at(-1)).toBe("response.completed");
    expect(server.stats.wsResponses).toBe(1);
    expect(server.stats.httpResponses).toBe(0);
    expect(driver.activeTransport).toBe("websocket");
  });

  it("continues an agent loop incrementally and the server sees the full history", async () => {
    const { driver, server, diagnostics } = await setup({
      script: ({ requestIndex }) =>
        requestIndex === 0
          ? { steps: [{ type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}' }] }
          : { steps: [{ type: "message", text: "listed", phase: "final_answer" }] },
    });
    const first = request([user("list files")], { tools, prompt_cache_key: "thread-1" });
    const firstResponse = await driver.createResponse(first).final();
    const call = firstResponse.output[0];
    expect(call?.type).toBe("function_call");
    const second = request(
      [
        ...first.input,
        ...firstResponse.output,
        { type: "function_call_output", call_id: call?.type === "function_call" ? call.call_id : "", output: "a.txt" },
      ],
      { tools, prompt_cache_key: "thread-1" },
    );
    const secondResponse = await driver.createResponse(second).final();
    expect(secondResponse.status).toBe("completed");
    expect(server.stats.wsIncrementalCreates).toBe(1);
    expect(server.requests[1]?.input).toHaveLength(3);
    expect(secondResponse.usage?.input_tokens_details.cached_tokens).toBeGreaterThan(0);
    expect(diagnostics.filter((d) => d.kind === "continuation").map((d) => d.kind === "continuation" && d.mode)).toEqual([
      "full",
      "incremental",
    ]);
  });

  it("keeps incremental continuation across a mid-thread effort change via configuration_update", async () => {
    const { driver, server } = await setup();
    const first = request([user("one")], { reasoning: { effort: "high" }, prompt_cache_key: "thread-effort" });
    const firstResponse = await driver.createResponse(first).final();
    const second = request(
      [...first.input, ...firstResponse.output, { type: "configuration_update", reasoning: { effort: "low" } }, user("two")],
      { reasoning: { effort: "high" }, prompt_cache_key: "thread-effort" },
    );
    const secondResponse = await driver.createResponse(second).final();
    expect(secondResponse.status).toBe("completed");
    expect(server.stats.wsIncrementalCreates).toBe(1);
    expect(server.requests[1]?.input.at(-2)).toEqual({ type: "configuration_update", reasoning: { effort: "low" } });
    expect(secondResponse.usage?.input_tokens_details.cached_tokens).toBeGreaterThan(0);
  });

  it("falls back to a full create when request properties change", async () => {
    const { driver, server } = await setup();
    const first = await driver.createResponse(request([user("one")])).final();
    await driver.createResponse(request([user("one"), ...first.output, user("two")], { max_output_tokens: 100 })).final();
    expect(server.stats.wsFullCreates).toBe(2);
    expect(server.stats.wsIncrementalCreates).toBe(0);
  });

  it("uses prewarm as a continuation base with an empty delta", async () => {
    const { driver, server } = await setup();
    const params = request([user("warm me")], { prompt_cache_key: "warm" });
    const warm = await driver.createResponse({ ...params, generate: false }).final();
    expect(warm.output).toEqual([]);
    const real = await driver.createResponse(params).final();
    expect(server.stats.wsIncrementalCreates).toBe(1);
    expect(real.usage?.input_tokens_details.cached_tokens).toBe(real.usage?.input_tokens);
  });

  it("interrupts gracefully and does not continue from an interrupted response", async () => {
    const { driver, server } = await setup({
      chunkDelayMs: 5,
      script: ({ requestIndex }) => ({ steps: [{ type: "message", text: requestIndex === 0 ? "long ".repeat(200) : "ok" }] }),
    });
    const stream = driver.createResponse(request([user("go")]));
    let interrupted = false;
    for await (const event of stream) {
      if (!interrupted && event.type === "response.output_text.delta") interrupted = stream.interrupt();
    }
    const response = await stream.final();
    expect(interrupted).toBe(true);
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details?.reason).toBe("interrupted");
    expect(server.stats.wsInterrupts).toBe(1);
    await driver.createResponse(request([user("go"), user("again")])).final();
    expect(server.stats.wsIncrementalCreates).toBe(0);
  });

  it("aborts with AporisaAbortError and recovers on a fresh connection", async () => {
    const { driver, server } = await setup({
      chunkDelayMs: 5,
      script: ({ requestIndex }) => ({ steps: [{ type: "message", text: requestIndex === 0 ? "slow ".repeat(200) : "ok" }] }),
    });
    const controller = new AbortController();
    const stream = driver.createResponse(request([user("go")]), { signal: controller.signal });
    await expect(
      (async () => {
        for await (const event of stream) if (event.type === "response.output_text.delta") controller.abort();
      })(),
    ).rejects.toBeInstanceOf(AporisaAbortError);
    const next = await driver.createResponse(request([user("again")])).final();
    expect(next.status).toBe("completed");
    expect(server.stats.wsConnections).toBe(2);
    expect(driver.activeTransport).toBe("websocket");
  });

  it("reconnects transparently after the server's connection lifetime expires", async () => {
    const { driver, server, diagnostics } = await setup({ connectionLifetimeMs: 30 });
    await driver.createResponse(request([user("one")])).final();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await driver.createResponse(request([user("two")])).final();
    expect(second.status).toBe("completed");
    expect(server.stats.wsConnections).toBe(2);
    expect(diagnostics.some((d) => d.kind === "transport_fallback")).toBe(false);
  });

  it("serves a concurrent request over HTTP while the WebSocket is busy", async () => {
    const { driver, server } = await setup({ chunkDelayMs: 2, concurrency: 2 });
    const [a, b] = await Promise.all([
      driver.createResponse(request([user("a")])).final(),
      driver.createResponse(request([user("b")])).final(),
    ]);
    expect([a.status, b.status]).toEqual(["completed", "completed"]);
    expect(server.stats.wsResponses).toBe(1);
    expect(server.stats.httpResponses).toBe(1);
  });
});

describe("native driver: HTTP and fallback", () => {
  it("uses HTTP when configured explicitly", async () => {
    const { driver, server } = await setup({}, { transport: "http" });
    const response = await driver.createResponse(request([user("hi")])).final();
    expect(response.status).toBe("completed");
    expect(server.stats.httpResponses).toBe(1);
    expect(server.stats.wsConnections).toBe(0);
  });

  it("falls back to HTTP for the rest of the session when the upgrade fails", async () => {
    const { driver, server, diagnostics } = await setup({ rejectWebSocketUpgrade: true });
    await driver.createResponse(request([user("one")])).final();
    await driver.createResponse(request([user("two")])).final();
    expect(server.stats.httpResponses).toBe(2);
    expect(driver.activeTransport).toBe("http");
    expect(diagnostics.filter((d) => d.kind === "transport_fallback")).toHaveLength(1);
  });

  it("falls back when the model does not declare the websocket capability", async () => {
    const { driver, server } = await setup({ model: mockModel({ capabilities: { ...mockModel().capabilities, websocket: false } }) });
    await driver.createResponse(request([user("hi")])).final();
    expect(server.stats.httpResponses).toBe(1);
    expect(driver.activeTransport).toBe("http");
  });

  it("aborts an HTTP stream with AporisaAbortError", async () => {
    const { driver } = await setup(
      { chunkDelayMs: 5, script: () => ({ steps: [{ type: "message", text: "slow ".repeat(200) }] }) },
      { transport: "http" },
    );
    const controller = new AbortController();
    const stream = driver.createResponse(request([user("go")]), { signal: controller.signal });
    await expect(
      (async () => {
        for await (const event of stream) if (event.type === "response.output_text.delta") controller.abort();
      })(),
    ).rejects.toBeInstanceOf(AporisaAbortError);
  });
});

describe("native driver: errors and retries", () => {
  for (const transport of ["websocket", "http"] as const) {
    it(`surfaces context_length_exceeded as AporisaApiError over ${transport}`, async () => {
      const { driver } = await setup({}, { transport });
      const huge = "a ".repeat(mockModel().context_window * 4);
      await expect(driver.createResponse(request([user(huge)])).final()).rejects.toMatchObject({
        name: "AporisaApiError",
        code: "context_length_exceeded",
        status: 400,
      });
    });

    it(`retries queue_full before the stream starts over ${transport}`, async () => {
      const { driver, baseUrl, server, diagnostics } = await setup(
        { chunkDelayMs: 5, maxQueue: 0, script: ({ requestIndex }) => ({ steps: [{ type: "message", text: requestIndex === 0 ? "busy ".repeat(40) : "ok" }] }) },
        { transport },
      );
      const blocker = new NativeDriver({ baseUrl, apiKey: server.apiKey, transport: "http" });
      const blocking = blocker.createResponse(request([user("block")])).final();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const retried = new NativeDriver({
        baseUrl,
        apiKey: server.apiKey,
        transport,
        sleep: async () => {
          await blocking;
        },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      cleanups.push(() => retried.close(), () => blocker.close());
      const response = await retried.createResponse(request([user("wait")])).final();
      expect(response.status).toBe("completed");
      expect(diagnostics.some((d) => d.kind === "retry" && d.code === "queue_full")).toBe(true);
    });
  }

  it("rejects undeclared capabilities locally without contacting the generator", async () => {
    const { driver, server } = await setup({ model: mockModel({ capabilities: { ...mockModel().capabilities, structured_output: false } }) });
    const stream = driver.createResponse(
      request([user("hi")], { text: { format: { type: "json_schema", name: "x", schema: { type: "object" }, strict: true } } }),
    );
    await expect(stream.final()).rejects.toBeInstanceOf(AporisaRequestError);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects configuration_update locally when the model does not declare effort updates", async () => {
    const { driver, server } = await setup({ model: mockModel({ capabilities: { ...mockModel().capabilities, reasoning_effort_updates: false } }) });
    const stream = driver.createResponse(request([user("hi"), { type: "configuration_update", reasoning: { effort: "low" } }]));
    await expect(stream.final()).rejects.toBeInstanceOf(AporisaRequestError);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects unknown request keys locally", async () => {
    const { driver } = await setup();
    const params = { ...request([user("hi")]), temperature: 0 } as unknown as ResponseParams;
    await expect(driver.createResponse(params).final()).rejects.toMatchObject({ code: "unsupported_parameter" });
  });

  it("counts input tokens exactly when declared and estimates otherwise", async () => {
    const exact = await setup();
    const params = request([user("count me")]);
    const counted = await exact.driver.countInputTokens(params);
    const usage = (await exact.driver.createResponse(params).final()).usage;
    expect(counted).toMatchObject({ estimated: false, input_tokens: usage?.input_tokens });
    const estimated = await setup({ model: mockModel({ capabilities: { ...mockModel().capabilities, input_tokens: false } }) });
    expect((await estimated.driver.countInputTokens(params)).estimated).toBe(true);
  });
});

describe("native driver: protocol enforcement", () => {
  async function rogueServer(events: object[]): Promise<{ baseUrl: string; server: Server }> {
    const model = mockModel({ capabilities: { ...mockModel().capabilities, websocket: false } });
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/v1/models/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(model));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) res.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, server };
  }

  const created = {
    type: "response.created",
    sequence_number: 0,
    response: { id: "resp_1", object: "response", created_at: 1, model: mockModel().id, status: "in_progress", output: [], usage: null, incomplete_details: null, error: null },
  };

  it("raises AporisaProtocolError when the stream ends without a terminal event", async () => {
    const { baseUrl } = await rogueServer([created]);
    const driver = new NativeDriver({ baseUrl, apiKey: "k" });
    await expect(driver.createResponse(request([user("hi")])).final()).rejects.toThrow(/without a terminal event/);
  });

  it("raises AporisaProtocolError on unknown event types", async () => {
    const { baseUrl } = await rogueServer([created, { type: "response.surprise", sequence_number: 1 }]);
    const driver = new NativeDriver({ baseUrl, apiKey: "k" });
    await expect(driver.createResponse(request([user("hi")])).final()).rejects.toBeInstanceOf(AporisaProtocolError);
  });

  it("raises AporisaProtocolError on broken sequence numbers", async () => {
    const { baseUrl } = await rogueServer([created, { ...created, sequence_number: 5 }]);
    const driver = new NativeDriver({ baseUrl, apiKey: "k" });
    await expect(driver.createResponse(request([user("hi")])).final()).rejects.toThrow(/sequence_number/);
  });

  it("classifies non-protocol error bodies as protocol errors, not API errors", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/html" });
      res.end("<h1>oops</h1>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const driver = new NativeDriver({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "k" });
    const error = await driver.listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AporisaProtocolError);
    expect(error).not.toBeInstanceOf(AporisaApiError);
  });
});
