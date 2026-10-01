// Runs the wire-level conformance suite against the mock server (the executable contract).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { missingCapability, pngDataUrl, wireCases, type WireContext } from "../src/conformance/wire.ts";
import { MockServer, mockModel } from "../src/mock/index.ts";

describe("wire conformance: mock server", () => {
  const server = new MockServer({ chunkSize: 4, chunkDelayMs: 2 });
  let context: WireContext;

  beforeAll(async () => {
    const baseUrl = await server.start();
    context = { target: { baseUrl, apiKey: server.apiKey, model: server.model.id }, model: server.model };
  });
  afterAll(() => server.close());

  for (const testCase of wireCases) {
    const run = missingCapability(testCase, server.model) ? it.skip : it;
    run(`${testCase.id} ${testCase.title}`, () => testCase.run(context));
  }
});

describe("wire conformance: a text-only model", () => {
  const server = new MockServer({ model: mockModel({ input_modalities: ["text"] }) });
  let context: WireContext;

  beforeAll(async () => {
    const baseUrl = await server.start();
    context = { target: { baseUrl, apiKey: server.apiKey, model: server.model.id }, model: server.model };
  });
  afterAll(() => server.close());

  // W27 expects unsupported_parameter for images; W28-W30 apply only to image models.
  for (const testCase of wireCases.filter((c) => ["W27", "W28", "W29", "W30"].includes(c.id))) {
    it(`${testCase.id} ${testCase.title}`, () => testCase.run(context));
  }
});

describe("mock server image limit (§11)", () => {
  const server = new MockServer({ maxImages: 2 });
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await server.start();
  });
  afterAll(() => server.close());

  it("rejects a request holding more images than the server allows", async () => {
    const image = { type: "input_image", image_url: pngDataUrl(8, 8, [1, 2, 3]) };
    const post = (count: number) =>
      fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: server.model.id,
          stream: true,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, ...Array(count).fill(image)] }],
        }),
      });
    const accepted = await post(2);
    expect(accepted.status).toBe(200);
    await accepted.text();
    const rejected = await post(3);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "invalid_request", param: "input" } });
  });
});
