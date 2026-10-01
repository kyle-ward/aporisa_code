// Tool registry and dispatch: unknown tools and malformed arguments become tool results
// the model can recover from, as in codex (protocol section 9.2: not tool_call_invalid).
import { HostError } from "../../host/index.ts";
import { schemaSubsetViolation, schemaValueViolation, type FunctionTool, type Model } from "../../protocol/index.ts";
import { applyPatchTool } from "./apply-patch/tool.ts";
import { execCommandTool, writeStdinTool } from "./exec.ts";
import { ToolError, type ToolContext, type ToolHandler, type ToolResult } from "./types.ts";
import { updatePlanTool } from "./update-plan.ts";
import { viewImageTool } from "./view-image.ts";

export interface ToolCall {
  name: string;
  /** JSON text as produced by the model. */
  arguments: string;
}

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();

  constructor(handlers: readonly ToolHandler[]) {
    for (const handler of handlers) {
      const name = handler.spec.name;
      if (this.handlers.has(name)) throw new Error(`duplicate tool: ${name}`);
      const violation = schemaSubsetViolation(handler.spec.parameters);
      if (violation) throw new Error(`tool ${name} has an unsupported schema: ${violation}`);
      this.handlers.set(name, handler);
    }
  }

  /** Tool specs in registration order; stable for the whole thread (prefix caching). */
  specs(): FunctionTool[] {
    return [...this.handlers.values()].map((handler) => handler.spec);
  }

  supportsParallel(name: string): boolean {
    return this.handlers.get(name)?.parallel ?? false;
  }

  async dispatch(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const handler = this.handlers.get(call.name);
    if (!handler) {
      const known = [...this.handlers.keys()].join(", ");
      return { output: `Unknown tool '${call.name}'. Available tools: ${known}.`, success: false };
    }
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      return { output: `Invalid arguments for ${call.name}: not valid JSON.`, success: false };
    }
    const violation = schemaValueViolation(args, handler.spec.parameters);
    if (violation) return { output: `Invalid arguments for ${call.name}: ${violation}.`, success: false };
    try {
      return await handler.run(args as Record<string, unknown>, context);
    } catch (error) {
      if (error instanceof ToolError || error instanceof HostError) return { output: error.message, success: false };
      throw error;
    }
  }
}

/** The F2 tool set (FD-02); view_image only for models that accept images. */
export function defaultTools(model: Pick<Model, "input_modalities">): ToolHandler[] {
  const tools: ToolHandler[] = [execCommandTool, writeStdinTool, applyPatchTool, updatePlanTool];
  if (model.input_modalities.includes("image")) tools.push(viewImageTool);
  return tools;
}
