import { describe, expect, it } from "vitest";
import {
  effectiveReasoningEffort,
  imageInfo,
  incrementalInput,
  inputImages,
  InputItem,
  requestViolation,
  parseStrictJson,
  schemaInstance,
  schemaSubsetViolation,
  schemaValueViolation,
  StreamValidator,
  StreamViolation,
  StrictJsonError,
  type ResponseObject,
  type ResponseParams,
  type StreamEvent,
} from "../src/protocol/index.ts";
import { MockEngine, mockModel } from "../src/mock/index.ts";
import { pngDataUrl } from "../src/conformance/wire.ts";

describe("strict JSON", () => {
  it("parses ordinary JSON like JSON.parse", () => {
    const text = '{"a":[1,-2.5e3,true,null,"x\\u00e9"],"b":{"c":{}}}';
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
  });
  it.each([
    ['{"a":1,"a":2}', "duplicate"],
    ['{"a":{"b":1,"b":1}}', "duplicate"],
    ["NaN", "unexpected"],
    ['{"a":1} x', "trailing"],
    ['{"a":01}', "expected"],
    ['"\u0001"', "control"],
  ])("rejects %s", (text, reason) => {
    expect(() => parseStrictJson(text)).toThrowError(new RegExp(reason));
    expect(() => parseStrictJson(text)).toThrow(StrictJsonError);
  });
});

describe("schema subset", () => {
  it("accepts the portable subset", () => {
    expect(
      schemaSubsetViolation({
        type: "object",
        properties: {
          q: { type: "string", description: "query" },
          n: { anyOf: [{ type: "integer" }, { type: "null" }] },
          tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
        },
        required: ["q"],
        additionalProperties: false,
      }),
    ).toBeNull();
  });
  it.each([
    [{ type: "string" }, "root"],
    [{ type: "object", properties: { q: { type: "string", pattern: "x" } } }, "pattern"],
    [{ type: "object", properties: { a: { type: "array" } } }, "items"],
    [{ type: "object", required: ["missing"] }, "required"],
    [{ type: "object", $defs: {} }, "\\$defs"],
    [{ type: ["string", "null"] }, "root"],
  ])("rejects %j", (schema, reason) => {
    expect(schemaSubsetViolation(schema)).toMatch(new RegExp(reason));
  });
});

const model = mockModel();
const request = (text: string, extra: Partial<ResponseParams> = {}): ResponseParams => ({
  model: model.id,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
  ...extra,
});

async function collect(params: ResponseParams): Promise<StreamEvent[]> {
  const engine = new MockEngine({ model });
  const events: StreamEvent[] = [];
  for await (const event of engine.run(params)) events.push(event);
  return events;
}

function feed(events: StreamEvent[]): StreamValidator {
  const validator = new StreamValidator();
  for (const event of events) validator.accept(event);
  return validator;
}

describe("stream validator", () => {
  it("accepts a well-formed stream and exposes the terminal response", async () => {
    const validator = feed(await collect(request("hello")));
    expect(validator.terminal?.status).toBe("completed");
    expect(validator.items).toHaveLength(1);
  });

  it("rejects a gap in sequence numbers", async () => {
    const events = await collect(request("hello"));
    const broken = events.map((event, index) => (index === 2 ? { ...event, sequence_number: 9 } : event));
    expect(() => feed(broken as StreamEvent[])).toThrow(StreamViolation);
  });

  it("rejects deltas that disagree with the done text", async () => {
    const events = await collect(request("hello"));
    const broken = events.map((event) =>
      event.type === "response.output_text.done" ? { ...event, text: "tampered" } : event,
    );
    expect(() => feed(broken)).toThrow(/differs/);
  });

  it("rejects a missing terminal usage and events after the terminal", async () => {
    const events = await collect(request("hello"));
    const last = events.at(-1) as Extract<StreamEvent, { type: "response.completed" }>;
    const noUsage = [...events.slice(0, -1), { ...last, response: { ...last.response, usage: null } }];
    expect(() => feed(noUsage)).toThrow(/invalid completed/);
    const extra = [...events, { ...last, sequence_number: last.sequence_number + 1 }];
    expect(() => feed(extra)).toThrow(/after the terminal/);
  });

  it("rejects terminal output that differs from the done items", async () => {
    const events = await collect(request("hello"));
    const last = events.at(-1) as Extract<StreamEvent, { type: "response.completed" }>;
    const response: ResponseObject = { ...last.response, output: [] };
    expect(() => feed([...events.slice(0, -1), { ...last, response }])).toThrow(/terminal output/);
  });

  it("rejects interleaved items", async () => {
    const engine = new MockEngine({
      model,
      script: () => ({ steps: [{ type: "message", text: "a" }, { type: "message", text: "b" }] }),
    });
    const events: StreamEvent[] = [];
    for await (const event of engine.run(request("x"))) events.push(event);
    const secondAdded = events.findIndex((event, index) => index > 1 && event.type === "response.output_item.added");
    const firstDone = events.findIndex((event) => event.type === "response.output_item.done");
    const reordered = [...events];
    const [moved] = reordered.splice(secondAdded, 1);
    reordered.splice(firstDone, 0, moved as StreamEvent);
    const renumbered = reordered.map((event, index) => ({ ...event, sequence_number: index }));
    expect(() => feed(renumbered as StreamEvent[])).toThrow(/interleave/);
  });
});

describe("continuation", () => {
  const first = request("one");
  const output = [
    { type: "message" as const, id: "msg_1", role: "assistant" as const, content: [{ type: "output_text" as const, text: "echo: one" }] },
  ];

  it("returns only the new items when the prefix and properties match", () => {
    const next: ResponseParams = {
      ...first,
      input: [...first.input, { ...output[0]!, id: "different-id" }, ...request("two").input],
    };
    expect(incrementalInput(first, output, next)).toEqual(request("two").input);
  });

  it("refuses when properties differ or history diverges", () => {
    const base = [...first.input, ...output];
    expect(incrementalInput(first, output, { ...first, input: base, max_output_tokens: 10 })).toBeNull();
    expect(incrementalInput(first, output, { ...first, input: [...request("other").input, ...output] })).toBeNull();
    expect(incrementalInput(first, output, { ...first, input: first.input })).toBeNull();
  });
});

describe("strict function tools (§8.3)", () => {
  const user = { type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "hi" }] };
  const tool = (strict?: boolean) => ({
    type: "function" as const,
    name: "lookup",
    parameters: { type: "object" as const, properties: {} },
    ...(strict === undefined ? {} : { strict }),
  });

  it("needs structured_output for strict: true only", () => {
    const plain = mockModel({ capabilities: { ...mockModel().capabilities, structured_output: false } });
    const params = (strict?: boolean): ResponseParams => ({ model: plain.id, input: [user], tools: [tool(strict)] });
    expect(requestViolation(params(true), plain)).toMatchObject({ code: "unsupported_parameter", param: "tools[0].strict" });
    expect(requestViolation(params(false), plain)).toBeNull();
    expect(requestViolation(params(), plain)).toBeNull();
    expect(requestViolation(params(true), mockModel())).toBeNull();
  });
});

describe("reasoning effort updates (§6.1)", () => {
  const model = mockModel();
  const user = { type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "hi" }] };
  const update = (effort: "none" | "low" | "medium" | "high") => ({ type: "configuration_update" as const, reasoning: { effort } });
  const call = { type: "function_call" as const, call_id: "call_1", name: "lookup", arguments: "{}" };
  const output = { type: "function_call_output" as const, call_id: "call_1", output: "x" };
  const params = (input: ResponseParams["input"], extra: Partial<ResponseParams> = {}): ResponseParams => ({ model: model.id, input, ...extra });

  it("accepts updates after completed tool calls and rejects them between a call and its output", () => {
    expect(requestViolation(params([user, call, output, update("high")]), model)).toBeNull();
    expect(requestViolation(params([user, call, update("high"), output]), model)).toMatchObject({ code: "invalid_request", param: "input[2]" });
  });

  it("requires the capability and a supported effort", () => {
    const undeclared = mockModel({ capabilities: { ...model.capabilities, reasoning_effort_updates: false } });
    expect(requestViolation(params([user, update("high")]), undeclared)).toMatchObject({ code: "unsupported_parameter", param: "input[1]" });
    const narrow = mockModel({ reasoning: { ...model.reasoning, supported_efforts: ["medium", "high"] } });
    expect(requestViolation(params([user, update("low")]), narrow)).toMatchObject({
      code: "unsupported_parameter",
      param: "input[1].reasoning.effort",
    });
  });

  it("is input-only and strict: no id, no extra keys", () => {
    expect(InputItem.safeParse(update("low")).success).toBe(true);
    expect(InputItem.safeParse({ ...update("low"), id: "cu_1" }).success).toBe(false);
    expect(InputItem.safeParse({ type: "configuration_update", reasoning: { effort: "low", summary: "auto" } }).success).toBe(false);
  });

  it("resolves the effective effort: last update, then the baseline, then the model default", () => {
    expect(effectiveReasoningEffort(params([user, update("low"), user, update("high")], { reasoning: { effort: "none" } }), model)).toBe("high");
    expect(effectiveReasoningEffort(params([user], { reasoning: { effort: "none" } }), model)).toBe("none");
    expect(effectiveReasoningEffort(params([user]), model)).toBe(model.reasoning.default_effort);
  });
});

describe("structured output values (§8.4)", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer" },
      ratio: { type: "number" },
      tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
      extra: { type: "object", properties: {}, additionalProperties: true },
    },
    required: ["name", "count"],
  };

  it("accepts conforming values and names the first violation", () => {
    expect(schemaValueViolation({ name: "x", count: 2, tags: ["a"], note: null, extra: { any: 1 } }, schema)).toBeNull();
    expect(schemaValueViolation({ name: "x" }, schema)).toMatch(/missing 'count'/);
    expect(schemaValueViolation({ name: "x", count: 1.5 }, schema)).toMatch(/\$\.count: expected an integer/);
    expect(schemaValueViolation({ name: "x", count: 1, tags: ["c"] }, schema)).toMatch(/\$\.tags\[0\]: not one of/);
    expect(schemaValueViolation({ name: "x", count: 1, note: 3 }, schema)).toMatch(/anyOf/);
    expect(schemaValueViolation({ name: "x", count: 1, other: 1 }, schema)).toMatch(/unexpected property 'other'/);
    expect(schemaValueViolation([], schema)).toMatch(/expected an object/);
  });

  it("generates instances that conform", () => {
    const value = schemaInstance(schema);
    expect(schemaValueViolation(value, schema)).toBeNull();
    expect(value).toMatchObject({ name: "text", count: 1, tags: ["a"], note: "text" });
  });
});

describe("input images (§7.1, §11)", () => {
  const model = mockModel();
  const png = pngDataUrl(40, 24, [10, 200, 30]);
  const pngBytes = Buffer.from(png.slice(png.indexOf(",") + 1), "base64");
  // SOI, APP0 (empty), SOF0 (height 24, width 40), EOI: the structure a JPEG check reads.
  const jpegBytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x18, 0x00, 0x28, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  const url = (type: string, bytes: Buffer) => `data:image/${type};base64,${bytes.toString("base64")}`;
  const user = (imageUrl: string) => ({
    type: "message" as const,
    role: "user" as const,
    content: [
      { type: "input_text" as const, text: "look" },
      { type: "input_image" as const, image_url: imageUrl },
    ],
  });

  it("reads the format and size of complete PNG and JPEG files", () => {
    expect(imageInfo(png)).toEqual({ format: "png", width: 40, height: 24 });
    expect(imageInfo(url("jpeg", jpegBytes))).toEqual({ format: "jpeg", width: 40, height: 24 });
  });

  it("rejects other bytes, a format that differs from the declared one and cut files", () => {
    expect(imageInfo(url("png", Buffer.from("plain text, no image")))).toBeNull();
    expect(imageInfo(url("jpeg", pngBytes))).toBeNull();
    expect(imageInfo(url("png", jpegBytes))).toBeNull();
    expect(imageInfo(url("png", pngBytes.subarray(0, pngBytes.length - 12)))).toBeNull();
    expect(imageInfo(url("jpeg", jpegBytes.subarray(0, jpegBytes.length - 2)))).toBeNull();
  });

  it("names the image that fails, in messages and in tool outputs", () => {
    const params = (input: ResponseParams["input"]): ResponseParams => ({ model: model.id, input });
    const broken = url("png", Buffer.from("nope"));
    expect(requestViolation(params([user(png)]), model)).toBeNull();
    expect(requestViolation(params([user(broken)]), model)).toMatchObject({ code: "invalid_image", param: "input[0].content[1]" });
    const call = { type: "function_call" as const, call_id: "c1", name: "shot", arguments: "{}" };
    const output = { type: "function_call_output" as const, call_id: "c1", output: [{ type: "input_image" as const, image_url: broken }] };
    expect(requestViolation(params([user(png), call, output]), model)).toMatchObject({ code: "invalid_image", param: "input[2].output[0]" });
    expect(inputImages([user(png), call, output]).map((image) => image.param)).toEqual(["input[0].content[1]", "input[2].output[0]"]);
  });

  it("checks the modality before the image itself", () => {
    const text = mockModel({ input_modalities: ["text"] });
    const params: ResponseParams = { model: text.id, input: [user(url("png", Buffer.from("nope")))] };
    expect(requestViolation(params, text)).toMatchObject({ code: "unsupported_parameter", param: "input[0]" });
  });
});
