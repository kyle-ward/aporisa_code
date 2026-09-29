import { describe, expect, it } from "vitest";
import { StubDriver, mockModel } from "../src/mock/index.ts";
import { AporisaRequestError } from "../src/sdk/index.ts";

const input = [{ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "hi" }] }];

describe("stub driver", () => {
  it("implements the client interface in-process with the full capability set", async () => {
    const stub = new StubDriver();
    expect(Object.values(await stub.capabilities(stub.model.id)).every((state) => state === "supported")).toBe(true);
    const response = await stub.createResponse({ model: stub.model.id, input }).final();
    expect(response.output[0]).toMatchObject({ type: "message", content: [{ text: "echo: hi" }] });
    expect(stub.requests).toHaveLength(1);
    expect((await stub.countInputTokens({ model: stub.model.id, input })).input_tokens).toBe(response.usage?.input_tokens);
  });

  it("supports interrupt like the WebSocket transport", async () => {
    const stub = new StubDriver({ script: () => ({ steps: [{ type: "message", text: "long ".repeat(50) }] }), chunkSize: 2 });
    const stream = stub.createResponse({ model: stub.model.id, input });
    for await (const event of stream) if (event.type === "response.output_text.delta") stream.interrupt();
    expect((await stream.final()).incomplete_details?.reason).toBe("interrupted");
  });

  it("applies the same capability checks as a real backend", async () => {
    const stub = new StubDriver({ model: mockModel({ capabilities: { ...mockModel().capabilities, custom_tools: false } }) });
    const stream = stub.createResponse({ model: stub.model.id, input, tools: [{ type: "custom", name: "apply_patch" }] });
    await expect(stream.final()).rejects.toBeInstanceOf(AporisaRequestError);
  });
});
