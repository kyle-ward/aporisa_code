// The apply_patch tool. A function tool with one string argument holding codex's patch
// format, for every driver (DEVELOPMENT_PLAN.md FD-05: codex itself now ships only the
// freeform form, which the local backend does not offer).
import { assessPatch, realPath } from "../../safety/index.ts";
import { askUser, declined, ToolError, unavailable, type ToolHandler } from "../types.ts";
import { commitPatch, PatchApplyError, planPatch, summarize } from "./apply.ts";
import { parsePatch, PatchParseError } from "./parser.ts";

export const APPLY_PATCH_DESCRIPTION = `Edits files with a patch. Put the whole patch in \`input\`:

*** Begin Patch
*** Add File: <path>
+<every line of the new file, each prefixed with +>
*** Delete File: <path>
*** Update File: <path>
*** Move to: <new path>          (optional, right after Update File)
@@ <a line just before the change, e.g. a function or class header>   (or a bare @@)
 <context line, prefixed with one space>
-<removed line>
+<added line>
*** End Patch

Rules:
- One patch may contain several Add/Delete/Update sections. Paths are relative to the working directory (absolute paths also work); never use a path outside the task.
- In an Update section, show about 3 unchanged lines of context before and after each change. Start each separate change in the same file with its own @@ line; use @@ <header> when the context alone is not unique.
- Add *** End of File after a change that must match the end of the file.
- The patch is applied only if every section matches; otherwise nothing changes and the error says which lines were not found.
- Do not re-read a file just to check a successful patch.`;

export const applyPatchTool: ToolHandler = {
  spec: {
    type: "function",
    name: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "The entire patch, from *** Begin Patch to *** End Patch." },
      },
      required: ["input"],
      additionalProperties: false,
    },
  },
  parallel: false,

  async run(args, context) {
    let hunks;
    try {
      hunks = parsePatch(args.input as string);
    } catch (error) {
      if (error instanceof PatchParseError) throw new ToolError(error.message);
      throw error;
    }
    let plan;
    try {
      plan = await planPatch(hunks, context.cwd, context.host.fs);
    } catch (error) {
      if (error instanceof PatchApplyError) throw new ToolError(`${error.message}\nThe patch was not applied; no file was changed.`);
      throw error;
    }
    const safety = context.safety;
    if (safety) {
      // apply_patch runs in the harness, not in the sandbox: check its paths against the
      // same policy (codex does the same), on real paths so symlinks cannot escape.
      const paths = await Promise.all([...plan.writes.keys()].map((path) => realPath(context.host.fs, path)));
      const assessment = assessPatch(safety.policy, safety.rules, paths);
      if (assessment.action === "refuse") throw new ToolError(assessment.message);
      if (assessment.action === "ask") {
        const decision = await askUser(context, { kind: "patch", cwd: context.cwd, changes: plan.changes, reason: assessment.reason, paths: assessment.paths });
        if (decision === "unavailable") return unavailable("This patch");
        if (decision === "denied") return declined("this patch");
        if (decision === "approved_for_session") safety.rules.rememberPaths(assessment.paths);
      }
    }
    await commitPatch(plan, context.host.fs);
    return { output: summarize(plan.changes), success: true, details: { kind: "patch", changes: plan.changes } };
  },
};
