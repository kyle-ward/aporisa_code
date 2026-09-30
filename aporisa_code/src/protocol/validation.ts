// Semantic request checks shared by servers (to reject) and clients (to avoid sending).
// Shape validation is done by the zod schemas; this covers docs/protocol.md §5–§8 rules
// that depend on the model or span several fields.
import type { InputItem } from "./items.ts";
import type { Model, ReasoningEffort } from "./models.ts";
import type { ResponseParams } from "./request.ts";
import type { HttpErrorCode } from "./errors.ts";
import { schemaSubsetViolation } from "./tools.ts";

export interface RequestViolation {
  code: HttpErrorCode;
  param: string | null;
  message: string;
}

function violation(code: HttpErrorCode, param: string | null, message: string): RequestViolation {
  return { code, param, message };
}

/** Checks a transport-independent request against the target model. */
export function requestViolation(params: ResponseParams, model: Model): RequestViolation | null {
  const caps = model.capabilities;
  if (params.parallel_tool_calls === true && !caps.parallel_tool_calls) {
    return violation("unsupported_parameter", "parallel_tool_calls", "Parallel tool calls are not supported.");
  }
  if (params.text !== undefined && !caps.structured_output) {
    return violation("unsupported_parameter", "text", "Structured output is not supported.");
  }
  if (params.generate === false && !caps.prewarm) {
    return violation("unsupported_parameter", "generate", "Prewarm is not supported.");
  }
  if (params.reasoning !== undefined) {
    if (!model.reasoning.supported_efforts.includes(params.reasoning.effort)) {
      return violation("unsupported_parameter", "reasoning.effort", "Reasoning effort is not supported.");
    }
    if (params.reasoning.summary !== undefined && !model.reasoning.summary) {
      return violation("unsupported_parameter", "reasoning.summary", "Reasoning summaries are not supported.");
    }
  }
  if (params.max_output_tokens !== undefined && params.max_output_tokens > model.max_output_tokens) {
    return violation("invalid_request", "max_output_tokens", "max_output_tokens exceeds the model limit.");
  }

  const toolNames = new Set<string>();
  for (const [index, tool] of (params.tools ?? []).entries()) {
    if (toolNames.has(tool.name)) {
      return violation("invalid_request", `tools[${index}].name`, "Tool names must be unique.");
    }
    toolNames.add(tool.name);
    if (tool.type === "custom" && !caps.custom_tools) {
      return violation("unsupported_parameter", `tools[${index}]`, "Custom tools are not supported.");
    }
    if (tool.type === "function") {
      const reason = schemaSubsetViolation(tool.parameters);
      if (reason) return violation("unsupported_schema", `tools[${index}].parameters`, `Unsupported schema: ${reason}.`);
    }
  }
  if (params.text !== undefined) {
    const reason = schemaSubsetViolation(params.text.format.schema);
    if (reason) return violation("unsupported_schema", "text.format.schema", `Unsupported schema: ${reason}.`);
  }
  return inputViolation(params.input, model);
}

/** Role/content rules and call/output pairing for an input item list (§6, §7.1). */
export function inputViolation(input: readonly InputItem[], model: Model): RequestViolation | null {
  const openCalls = new Map<string, "function_call" | "custom_tool_call">();
  const seenCalls = new Set<string>();
  for (const [index, item] of input.entries()) {
    const param = `input[${index}]`;
    switch (item.type) {
      case "message": {
        for (const part of item.content) {
          const allowed =
            item.role === "assistant"
              ? part.type === "output_text"
              : part.type === "input_text" || (part.type === "input_image" && item.role === "user");
          if (!allowed) return violation("invalid_request", param, "Content part is not allowed for this role.");
          if (part.type === "input_image" && !model.input_modalities.includes("image")) {
            return violation("unsupported_parameter", param, "Image input is not supported.");
          }
        }
        if (item.phase !== undefined && item.role !== "assistant") {
          return violation("invalid_request", `${param}.phase`, "phase is only valid on assistant messages.");
        }
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        if (item.type === "custom_tool_call" && !model.capabilities.custom_tools) {
          return violation("unsupported_parameter", param, "Custom tools are not supported.");
        }
        if (seenCalls.has(item.call_id)) {
          return violation("invalid_request", `${param}.call_id`, "call_id must be unique.");
        }
        seenCalls.add(item.call_id);
        openCalls.set(item.call_id, item.type);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const expected = item.type === "function_call_output" ? "function_call" : "custom_tool_call";
        if (openCalls.get(item.call_id) !== expected) {
          return violation("invalid_request", `${param}.call_id`, "Tool output does not match an earlier call.");
        }
        openCalls.delete(item.call_id);
        const parts = typeof item.output === "string" ? [] : item.output;
        if (parts.some((part) => part.type === "input_image") && !model.input_modalities.includes("image")) {
          return violation("unsupported_parameter", param, "Image input is not supported.");
        }
        break;
      }
      case "configuration_update": {
        if (!model.capabilities.reasoning_effort_updates) {
          return violation("unsupported_parameter", param, "Reasoning effort updates are not supported.");
        }
        if (!model.reasoning.supported_efforts.includes(item.reasoning.effort)) {
          return violation("unsupported_parameter", `${param}.reasoning.effort`, "Reasoning effort is not supported.");
        }
        if (openCalls.size > 0) {
          return violation("invalid_request", param, "A configuration update cannot precede pending tool outputs.");
        }
        break;
      }
      case "reasoning":
        break;
    }
  }
  if (openCalls.size > 0) {
    return violation("invalid_request", "input", "Every tool call needs exactly one later output.");
  }
  return null;
}

/**
 * Effort in force for the generation (§6.1): the last configuration_update in the (expanded)
 * input, else the request baseline, else the model default.
 */
export function effectiveReasoningEffort(
  params: Pick<ResponseParams, "input" | "reasoning">,
  model: Model,
): ReasoningEffort {
  for (let index = params.input.length - 1; index >= 0; index -= 1) {
    const item = params.input[index];
    if (item?.type === "configuration_update") return item.reasoning.effort;
  }
  return params.reasoning?.effort ?? model.reasoning.default_effort;
}
