// Runs the wire-level conformance suite against the mock server (the executable contract).
import { afterAll, beforeAll, describe, it } from "vitest";
import { missingCapability, wireCases, type WireContext } from "../src/conformance/wire.ts";
import { MockServer } from "../src/mock/index.ts";

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
