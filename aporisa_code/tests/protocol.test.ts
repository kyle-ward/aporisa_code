import { describe, expect, it } from "vitest";
import {
  effectiveReasoningEffort,
  incrementalInput,
  InputItem,
  requestViolation,
  parseStrictJson,
  schemaSubsetViolation,
  StreamValidator,
  StreamViolation,
  StrictJsonError,
  type ResponseObject,
  type ResponseParams,
  type StreamEvent,
} from "../src/protocol/index.ts";
import { MockEngine, mockModel } from "../src/mock/index.ts";

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
