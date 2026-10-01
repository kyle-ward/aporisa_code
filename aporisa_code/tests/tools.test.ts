import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeHost, type ProcessManager } from "../src/host/index.ts";
import { dirname as posixDirname, normalize, resolve as posixResolve } from "../src/harness/paths.ts";
import {
  defaultTools,
  deriveNewContents,
  formattedTruncateText,
  parsePatch,
  seekSequence,
  ToolRegistry,
  truncateText,
  truncateToolOutput,
  type ApprovalRequest,
  type ToolContext,
} from "../src/harness/tools/index.ts";
import { SessionRules } from "../src/harness/safety/index.ts";
import { mockModel } from "../src/mock/index.ts";

const host = new NodeHost({ shell: "/bin/sh" });
const registry = new ToolRegistry(defaultTools(mockModel()));
let root: string;
let processes: ProcessManager;

/** A sandboxed, ask-for-everything policy writable only in `root` (a real path). */
function untrusted(root: string): ToolContext["safety"] {
  return {
    policy: { sandbox: "workspace-write", approval: "untrusted", network: false, writableRoots: [root], protectedNames: [".git"], denyPaths: [], stripSecrets: true },
    rules: new SessionRules(),
  };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { host, cwd: root, processes, truncation: { mode: "bytes", limit: 10_000 }, ...overrides };
}

function call(name: string, args: unknown, overrides: Partial<ToolContext> = {}) {
  return registry.dispatch({ name, arguments: JSON.stringify(args) }, context(overrides));
}

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aporisa-tools-"));
  processes = host.openProcessManager();
});

afterEach(async () => {
  await processes.terminateAll();
  await rm(root, { recursive: true, force: true });
});

describe("posix paths", () => {
  it("normalizes and resolves", () => {
    expect(normalize("/a/./b/../c//d/")).toBe("/a/c/d");
    expect(normalize("a/../../b")).toBe("../b");
    expect(posixResolve("/work", "src/x.ts")).toBe("/work/src/x.ts");
    expect(posixResolve("/work", "/etc/hosts")).toBe("/etc/hosts");
    expect(posixResolve("/work", "../up")).toBe("/up");
    expect(posixDirname("/a/b/c.txt")).toBe("/a/b");
    expect(posixDirname("/a")).toBe("/");
  });
});

describe("truncation (codex format)", () => {
  it("keeps head and tail on character boundaries with a marker", () => {
    expect(truncateText("0123456789abcdefghij", { mode: "bytes", limit: 10 })).toBe("01234…10 chars truncated…fghij");
    expect(truncateText("x".repeat(100), { mode: "tokens", limit: 5 })).toBe(`${"x".repeat(10)}…20 tokens truncated…${"x".repeat(10)}`);
    const cut = truncateText("é".repeat(10), { mode: "bytes", limit: 7 });
    expect(cut).toBe("é…7 chars truncated…éé");
    expect(truncateText("short", { mode: "bytes", limit: 10 })).toBe("short");
  });

  it("adds the warning header and keeps images in content arrays", () => {
    expect(formattedTruncateText("a\nb\nc\n" + "z".repeat(50), { mode: "bytes", limit: 10 })).toMatch(
      /^Warning: truncated output \(original token count: 14\)\nTotal output lines: 4\n\na\nb\nc…/,
    );
    const image = { type: "input_image" as const, image_url: "data:image/png;base64,AAAA" };
    const result = truncateToolOutput([{ type: "input_text", text: "y".repeat(40) }, image], { mode: "bytes", limit: 10 });
    expect(result).toEqual([{ type: "input_text", text: expect.stringContaining("Warning: truncated output") }, image]);
  });
});

describe("apply_patch parser (codex cases)", () => {
  it("parses all hunk kinds", () => {
    expect(
      parsePatch(
        patch("*** Add File: path/add.py\n+abc\n+def\n*** Delete File: path/delete.py\n*** Update File: path/update.py\n*** Move to: path/update2.py\n@@ def f():\n-    pass\n+    return 123"),
      ),
    ).toEqual([
      { type: "add", path: "path/add.py", contents: "abc\ndef\n" },
      { type: "delete", path: "path/delete.py" },
      {
        type: "update",
        path: "path/update.py",
        movePath: "path/update2.py",
        chunks: [{ changeContext: "def f():", oldLines: ["    pass"], newLines: ["    return 123"], isEndOfFile: false }],
      },
    ]);
  });

  it("reports malformed patches the way codex does", () => {
    expect(() => parsePatch("bad")).toThrow("invalid patch: The first line of the patch must be '*** Begin Patch'");
    expect(() => parsePatch("*** Begin Patch\nbad")).toThrow("The last line of the patch must be '*** End Patch'");
    expect(() => parsePatch(patch("*** Update File: test.py"))).toThrow("invalid hunk at line 2, Update file hunk for path 'test.py' is empty");
    expect(() => parsePatch(patch("*** Frobnicate File: x"))).toThrow("is not a valid hunk header");
    expect(parsePatch("*** Begin Patch\n*** End Patch")).toEqual([]);
  });

  it("accepts a heredoc wrapper and a final marker with surrounding spaces", () => {
    expect(parsePatch(`<<'EOF'\n${patch("*** Add File: a\n+x")}\nEOF`)).toEqual([{ type: "add", path: "a", contents: "x\n" }]);
    expect(parsePatch("*** Begin Patch\n*** Update File: f\n@@\n+x\n *** End Patch")).toHaveLength(1);
    expect(parsePatch(patch("*** Update File: file.txt\n@@\n+quux\n*** End of File\n"))[0]).toMatchObject({
      chunks: [{ newLines: ["quux"], isEndOfFile: true }],
    });
  });
});

describe("apply_patch matching (codex cases)", () => {
  it("seeks exact, then trailing-space-insensitive, then trimmed, then punctuation-folded", () => {
    expect(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false)).toBe(1);
    expect(seekSequence(["foo   ", "bar\t\t"], ["foo", "bar"], 0, false)).toBe(0);
    expect(seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0, false)).toBe(0);
    expect(seekSequence(["just one line"], ["too", "many", "lines"], 0, false)).toBeNull();
    expect(seekSequence(["a", "x", "a", "x"], ["a", "x"], 0, true)).toBe(2);
  });

  it("applies several chunks, interleaved changes and an end-of-file insertion", () => {
    const multi = parsePatch(patch("*** Update File: m\n@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX"))[0];
    expect(multi?.type === "update" && deriveNewContents("foo\nbar\nbaz\nqux\n", "m", multi.chunks)).toBe("foo\nBAR\nbaz\nQUX\n");
    const interleaved = parsePatch(patch("*** Update File: i\n@@\n a\n-b\n+B\n@@\n c\n d\n-e\n+E\n@@\n f\n+g\n*** End of File"))[0];
    expect(interleaved?.type === "update" && deriveNewContents("a\nb\nc\nd\ne\nf\n", "i", interleaved.chunks)).toBe("a\nB\nc\nd\nE\nf\ng\n");
    const additionFirst = parsePatch(patch("*** Update File: p\n@@\n+after-context\n+second-line\n@@\n line1\n-line2\n-line3\n+line2-replacement"))[0];
    expect(additionFirst?.type === "update" && deriveNewContents("line1\nline2\nline3\n", "p", additionFirst.chunks)).toBe(
      "line1\nline2-replacement\nafter-context\nsecond-line\n",
    );
    const dash = parsePatch(patch("*** Update File: u\n@@\n-import asyncio  # local import - avoids top-level dep\n+import asyncio  # HELLO"))[0];
    expect(dash?.type === "update" && deriveNewContents("import asyncio  # local import – avoids top‑level dep\n", "u", dash.chunks)).toBe(
      "import asyncio  # HELLO\n",
    );
  });
});

describe("apply_patch tool", () => {
  it("adds, updates, moves and deletes files and summarizes like codex", async () => {
    await writeFile(join(root, "keep.txt"), "one\ntwo\nthree\n");
    await writeFile(join(root, "old.txt"), "x\n");
    await writeFile(join(root, "gone.txt"), "bye\n");
    const result = await call("apply_patch", {
      input: patch(
        "*** Add File: nested/dir/new.txt\n+hello\n*** Update File: keep.txt\n@@\n one\n-two\n+TWO\n*** Update File: old.txt\n*** Move to: moved/new-name.txt\n@@\n-x\n+y\n*** Delete File: gone.txt",
      ),
    });
    expect(result).toMatchObject({
      success: true,
      output: "Success. Updated the following files:\nA nested/dir/new.txt\nM keep.txt\nM moved/new-name.txt\nD gone.txt",
      details: { kind: "patch", changes: [{ kind: "add" }, { kind: "update" }, { kind: "update", movePath: "moved/new-name.txt" }, { kind: "delete" }] },
    });
    expect(await readFile(join(root, "nested/dir/new.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    expect(await readFile(join(root, "moved/new-name.txt"), "utf8")).toBe("y\n");
    expect((await readdir(root)).sort()).toEqual(["keep.txt", "moved", "nested"]);
  });

  it("changes nothing when any section fails to match", async () => {
    await writeFile(join(root, "a.txt"), "alpha\n");
    await writeFile(join(root, "b.txt"), "beta\n");
    const result = await call("apply_patch", {
      input: patch("*** Update File: a.txt\n@@\n-alpha\n+ALPHA\n*** Update File: b.txt\n@@\n-gamma\n+GAMMA"),
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Failed to find expected lines in b.txt:\ngamma");
    expect(result.output).toContain("no file was changed");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("keeps an executable file executable and reports parse errors to the model", async () => {
    await writeFile(join(root, "run.sh"), "echo a\n");
    await chmod(join(root, "run.sh"), 0o755);
    await call("apply_patch", { input: patch("*** Update File: run.sh\n@@\n-echo a\n+echo b") });
    expect((await stat(join(root, "run.sh"))).mode & 0o777).toBe(0o755);
    expect((await call("apply_patch", { input: "not a patch" })).output).toContain("The first line of the patch must be '*** Begin Patch'");
    expect((await call("apply_patch", { input: patch("*** Update File: missing.txt\n@@\n-a\n+b") })).output).toContain("missing.txt: no such file");
  });

  it("asks before writing (untrusted policy) and leaves files alone when declined", async () => {
    const asked: ApprovalRequest[] = [];
    const real = await host.fs.realpath(root);
    const result = await call(
      "apply_patch",
      { input: patch("*** Add File: x.txt\n+x") },
      { safety: untrusted(real), approve: async (request) => (asked.push(request), "denied") },
    );
    expect(asked).toEqual([{ kind: "patch", cwd: root, changes: [{ path: "x.txt", kind: "add" }], reason: "untrusted", paths: [`${real}/x.txt`] }]);
    expect(result).toMatchObject({ success: false, output: expect.stringContaining("declined") });
    expect(await readdir(root)).toEqual([]);
  });
});

describe("exec_command and write_stdin", () => {
  it("returns the codex header with the exit code", async () => {
    await mkdir(join(root, "sub"));
    const result = await call("exec_command", { cmd: "pwd; exit 2", workdir: "sub" });
    expect(result.output).toMatch(/^Wall time: \d+\.\d{4} seconds\nProcess exited with code 2\nOutput:\n.*\/sub\n$/);
    expect(result).toMatchObject({ success: false, details: { kind: "command", exitCode: 2, sessionId: null } });
  });

  it("hands out a session id for a running command and continues it", async () => {
    const first = await call("exec_command", { cmd: "echo waiting; read x; echo got $x", yield_time_ms: 250 });
    expect(first.output).toMatch(/Process running with session ID 1\nOutput:\nwaiting\n$/);
    const second = await call("write_stdin", { session_id: 1, chars: "hi\n", yield_time_ms: 3000 });
    expect(second.output).toMatch(/Process exited with code 0\nOutput:\ngot hi\n$/);
    expect((await call("write_stdin", { session_id: 1 })).output).toContain("Unknown session ID 1");
  });

  it("truncates to the smaller of the request and the policy and keeps the full text", async () => {
    const result = await call("exec_command", { cmd: "printf '%0400d' 0" }, { truncation: { mode: "bytes", limit: 200 } });
    expect(result.output).toContain("Original token count: 100");
    const bytes = (text: unknown) => new TextEncoder().encode(text as string).byteLength;
    expect(bytes(result.output)).toBeLessThanOrEqual(240);
    expect(bytes((result.output as string).split("Output:\n")[1])).toBeLessThanOrEqual(200);
    expect(result.fullOutput).toBe("0".repeat(400));
    const small = await call("exec_command", { cmd: "printf '%0400d' 0", max_output_tokens: 10 });
    expect(bytes((small.output as string).split("Output:\n")[1])).toBeLessThanOrEqual(40);
    expect(small.output).toContain("chars truncated");
  });

  it("asks before running (untrusted policy) and does not start a declined command", async () => {
    const asked: ApprovalRequest[] = [];
    const result = await call(
      "exec_command",
      { cmd: "touch made" },
      { safety: untrusted(await host.fs.realpath(root)), approve: async (request) => (asked.push(request), "denied") },
    );
    expect(asked).toEqual([{ kind: "command", command: "touch made", cwd: root, reason: "untrusted", sandboxed: true, rememberPrefixes: [["touch"]] }]);
    expect(result.success).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("view_image and update_plan", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

  it("returns a PNG as an input_image and rejects other formats", async () => {
    await writeFile(join(root, "shot.png"), png);
    await writeFile(join(root, "notes.txt"), "text");
    const result = await call("view_image", { path: "shot.png" });
    expect(result.output).toEqual([{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}`, detail: "auto" }]);
    expect((await call("view_image", { path: "notes.txt" })).output).toContain("is not a PNG or JPEG image");
    expect((await call("view_image", { path: "missing.png" })).output).toContain("no such file");
  });

  it("is offered only to models that accept images", () => {
    expect(new ToolRegistry(defaultTools(mockModel({ input_modalities: ["text"] }))).specs().map((spec) => spec.name)).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "update_plan",
    ]);
  });

  it("records the plan and enforces a single in_progress step", async () => {
    const result = await call("update_plan", { explanation: "start", plan: [{ step: "a", status: "in_progress" }, { step: "b", status: "pending" }] });
    expect(result).toMatchObject({ output: "Plan updated", details: { kind: "plan", explanation: "start", plan: [{ step: "a" }, { step: "b" }] } });
    const bad = await call("update_plan", { plan: [{ step: "a", status: "in_progress" }, { step: "b", status: "in_progress" }] });
    expect(bad).toMatchObject({ success: false, output: "At most one step can be in_progress at a time." });
  });
});

describe("registry", () => {
  it("turns unknown tools and bad arguments into results the model can act on", async () => {
    expect((await registry.dispatch({ name: "read_file", arguments: "{}" }, context())).output).toContain("Unknown tool 'read_file'");
    expect((await registry.dispatch({ name: "exec_command", arguments: "{" }, context())).output).toBe("Invalid arguments for exec_command: not valid JSON.");
    expect((await call("exec_command", { command: "ls" })).output).toContain("Invalid arguments for exec_command: $: missing 'cmd'");
    expect((await call("update_plan", { plan: [{ step: "a", status: "done" }] })).output).toContain("not one of the enum values");
  });

  it("exposes stable specs inside the protocol's schema subset and the codex parallel rules", () => {
    expect(registry.specs().map((spec) => spec.name)).toEqual(["exec_command", "write_stdin", "apply_patch", "update_plan", "view_image"]);
    expect(["exec_command", "write_stdin", "view_image"].every((name) => registry.supportsParallel(name))).toBe(true);
    expect(registry.supportsParallel("apply_patch") || registry.supportsParallel("update_plan")).toBe(false);
  });
});
