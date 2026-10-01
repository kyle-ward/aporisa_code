// update_plan, after codex (core/src/tools/handlers/plan_spec.rs). The plan lives in the
// tool call itself; the harness only reports it.
import { ToolError, type PlanItem, type ToolHandler } from "./types.ts";

export const updatePlanTool: ToolHandler = {
  spec: {
    type: "function",
    name: "update_plan",
    description:
      "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.",
    parameters: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Optional explanation for this plan update." },
        plan: {
          type: "array",
          description: "The list of steps",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "One of: pending, in_progress, completed" },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  parallel: false,

  async run(args) {
    const plan = args.plan as PlanItem[];
    if (plan.filter((item) => item.status === "in_progress").length > 1) {
      throw new ToolError("At most one step can be in_progress at a time.");
    }
    const explanation = typeof args.explanation === "string" ? args.explanation : undefined;
    return {
      output: "Plan updated",
      success: true,
      details: { kind: "plan", plan, ...(explanation !== undefined ? { explanation } : {}) },
    };
  },
};
