// The engine is the executable contract; these cases pin its scripted behaviour.
import { describe, expect, it } from "vitest";
import type { ResponseObject, ResponseParams, StreamEvent, ToolSpec } from "../src/protocol/index.ts";
import { MockEngine, mockModel, type MockScript } from "../src/mock/index.ts";

const model = mockModel();
const tools: ToolSpec[] = [
  { type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
  { type: "custom", name: "apply_patch", format: { type: "text" } },
];

function params(extra: Partial<ResponseParams> = {}): ResponseParams {
  return {
    model: model.id,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }],
    tools,
    ...extra,
  };
}

async function run(script: MockScript, extra: Partial<ResponseParams> = {}, engine?: MockEngine) {
  const target = engine ?? new MockEngine({ model, script, chunkSize: 3 });
  const events: StreamEvent[] = [];
  for await (const event of target.run(params(extra))) events.push(event);
  const last = events.at(-1) as { response: ResponseObject };
  return { events, response: last.response };
}

describe("mock engine", () => {
  it("streams reasoning, commentary, function and custom tool calls", async () => {
    const { response, events } = await run(
      () => ({
        steps: [
          { type: "reasoning", text: "think", summary: "plan" },
          { type: "message", text: "Running ls.", phase: "commentary" },
          { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}' },
          { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" },
        ],
      }),
      { parallel_tool_calls: true, reasoning: { effort: "high", summary: "auto" } },
    );
    expect(response.status).toBe("completed");
    expect(response.output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call", "custom_tool_call"]);
    expect(response.output[0]).toMatchObject({ summary: [{ text: "plan" }], content: [{ text: "think" }] });
    expect(events.some((event) => event.type === "response.reasoning_summary_text.delta")).toBe(true);
    expect(response.usage?.output_tokens_details.reasoning_tokens).toBeGreaterThan(0);
  });

  it("stops after the first tool call unless parallel tool calls are enabled", async () => {
    const script: MockScript = () => ({
      steps: [
        { type: "function_call", name: "exec_command", arguments: "{}" },
        { type: "function_call", name: "exec_command", arguments: "{}" },
      ],
    });
    expect((await run(script)).response.output).toHaveLength(1);
    expect((await run(script, { parallel_tool_calls: true })).response.output).toHaveLength(2);
  });

  it("honours tool_choice none and reasoning effort none", async () => {
    const script: MockScript = () => ({
      steps: [
        { type: "reasoning", text: "hidden" },
        { type: "function_call", name: "exec_command", arguments: "{}" },
        { type: "message", text: "done" },
      ],
    });
    const { response } = await run(script, { tool_choice: "none", reasoning: { effort: "none" } });
    expect(response.output.map((item) => item.type)).toEqual(["message"]);
  });

  it("applies the effective effort from configuration_update over the request baseline", async () => {
    const script: MockScript = () => ({ steps: [{ type: "reasoning", text: "think" }, { type: "message", text: "done" }] });
    const user = params().input[0]!;
    const toNone = await run(script, { reasoning: { effort: "high" }, input: [user, { type: "configuration_update", reasoning: { effort: "none" } }] });
    expect(toNone.response.output.map((item) => item.type)).toEqual(["message"]);
    expect(toNone.response.usage?.output_tokens_details.reasoning_tokens).toBe(0);
    const toHigh = await run(script, { reasoning: { effort: "none" }, input: [user, { type: "configuration_update", reasoning: { effort: "high" } }] });
    expect(toHigh.response.output.map((item) => item.type)).toEqual(["reasoning", "message"]);
  });

  it("ends with tool_call_invalid after keeping the items completed before it", async () => {
    const { response, events } = await run(() => ({
      steps: [{ type: "message", text: "Let me check.", phase: "commentary" }, { type: "reasoning", text: "unused" }],
      failAfter: { steps: 1, code: "tool_call_invalid", message: "Tool call markup is not closed." },
    }));
    expect(response.status).toBe("failed");
    expect(response.error).toEqual({ code: "tool_call_invalid", message: "Tool call markup is not closed." });
    expect(response.output.map((item) => item.type)).toEqual(["message"]);
    expect(events.at(-1)?.type).toBe("response.failed");
  });

  it("rejects scripts that call undeclared tools", async () => {
    await expect(run(() => ({ steps: [{ type: "function_call", name: "nope", arguments: "{}" }] }))).rejects.toThrow(/undeclared/);
  });

  it("ends incomplete with truncated text when max_output_tokens is reached", async () => {
    const { response } = await run(() => ({ steps: [{ type: "message", text: "x".repeat(100) }] }), { max_output_tokens: 5 });
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details?.reason).toBe("max_output_tokens");
    expect(response.usage?.output_tokens).toBe(5);
    expect(response.output[0]).toMatchObject({ content: [{ text: "x".repeat(15) }] });
  });

  it("emits response.failed at the scripted point", async () => {
    const { response } = await run(() => ({
      steps: [{ type: "message", text: "partial" }, { type: "message", text: "never" }],
      failAfter: { steps: 1, code: "engine_failure", message: "boom" },
    }));
    expect(response.status).toBe("failed");
    expect(response.error).toEqual({ code: "engine_failure", message: "boom" });
    expect(response.output).toHaveLength(1);
  });

  it("reports cached tokens for a repeated prefix under the same prompt_cache_key", async () => {
    const engine = new MockEngine({ model });
    const first = await run(() => ({ steps: [] }), { prompt_cache_key: "k" }, engine);
    expect(first.response.usage?.input_tokens_details.cached_tokens).toBe(0);
    const second = await run(() => ({ steps: [] }), { prompt_cache_key: "k" }, engine);
    expect(second.response.usage?.input_tokens_details.cached_tokens).toBe(second.response.usage?.input_tokens);
    const other = await run(() => ({ steps: [] }), { prompt_cache_key: "other" }, engine);
    expect(other.response.usage?.input_tokens_details.cached_tokens).toBe(0);
  });

  it("prewarm completes without output and seeds the prefix cache", async () => {
    const engine = new MockEngine({ model });
    const warm = await run(() => ({ steps: [] }), { generate: false, prompt_cache_key: "w" }, engine);
    expect(warm.events.map((event) => event.type)).toEqual(["response.created", "response.completed"]);
    const real = await run(() => ({ steps: [{ type: "message", text: "hi" }] }), { prompt_cache_key: "w" }, engine);
    expect(real.response.usage?.input_tokens_details.cached_tokens).toBe(real.response.usage?.input_tokens);
  });
});
