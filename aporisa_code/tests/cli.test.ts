import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, parseEnv } from "../src/cli/env.ts";
import { runCli, type CliIo } from "../src/cli/main.ts";
import { approvalQuestion, parseApproval, renderer } from "../src/cli/render.ts";

let root: string;

function io(stdinText = "", tty = false): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdin = Object.assign(Readable.from(stdinText ? [stdinText] : []), { isTTY: tty });
  return { stdout, stderr, output: { out: (text) => stdout.push(text), err: (text) => stderr.push(text) }, stdin, invocationDir: root, colors: false };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aporisa-cli-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe(".env", () => {
  it("parses KEY=VALUE lines with comments and quotes", () => {
    expect(parseEnv('# c\n\nAPORISA_BASE_URL = http://127.0.0.1:18080/v1\nAPORISA_API_KEY="k=1"\n')).toEqual({
      APORISA_BASE_URL: "http://127.0.0.1:18080/v1",
      APORISA_API_KEY: "k=1",
    });
    expect(() => parseEnv("oops")).toThrow("not KEY=VALUE");
  });

  it("lets the environment win and rejects unknown keys", async () => {
    const path = join(root, ".env");
    await writeFile(path, "APORISA_BASE_URL=http://file/v1\nAPORISA_MODEL=m\n");
    expect(loadEnv(path, { APORISA_BASE_URL: "http://env/v1" })).toEqual({ APORISA_BASE_URL: "http://env/v1", APORISA_MODEL: "m" });
    expect(loadEnv(join(root, "missing"), {})).toEqual({});
    await writeFile(path, "SOMETHING_ELSE=1\n");
    expect(() => loadEnv(path, {})).toThrow("unknown keys");
  });
});

describe("aporisa CLI", () => {
  it("runs one turn with the stub driver and prints the answer on stdout", async () => {
    const terminal = io();
    expect(await runCli(["exec", "--driver", "stub", "--no-persist", "hello", "there"], terminal)).toBe(0);
    expect(terminal.stdout.join("")).toBe("echo: hello there\n");
    expect(terminal.stderr.join("")).toContain("turn completed: 1 requests");
  });

  it("reads the task from stdin and prints JSONL events with --json", async () => {
    const terminal = io("from stdin\n");
    expect(await runCli(["exec", "--driver", "stub", "--no-persist", "--json", "-"], terminal)).toBe(0);
    const events = terminal.stdout.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: "thread.started", cwd: expect.stringContaining("aporisa-cli-") });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", outcome: { status: "completed", lastMessage: "echo: from stdin" } });
  });

  it("rejects bad usage with exit code 2", async () => {
    for (const argv of [["frob"], ["exec", "--effort", "max", "x"], ["exec", "--driver", "openai", "x"], ["exec", "--max-requests", "0", "x"]]) {
      const terminal = io();
      expect(await runCli(argv, terminal)).toBe(2);
      expect(terminal.stderr.join("")).toMatch(/^ERROR: /);
    }
    const missing = io();
    expect(await runCli(["exec", "--driver", "stub", "--image", "nope.png", "x"], missing)).toBe(2);
  });

  it("maps the safety flags and rejects contradictory ones", async () => {
    for (const argv of [
      ["exec", "--dangerously-bypass-sandbox", "--sandbox", "read-only", "x"],
      ["exec", "--dangerously-bypass-sandbox", "--network", "x"],
      ["exec", "--auto", "--approval", "untrusted", "x"],
      ["exec", "--sandbox", "open", "x"],
      ["exec", "--approval", "sometimes", "x"],
    ]) {
      const terminal = io();
      expect(await runCli(argv, terminal), argv.join(" ")).toBe(2);
    }
    const cases: [string[], object][] = [
      [[], { sandbox: "workspace-write", approval: "on-request", network: false }],
      [["--sandbox", "read-only", "--network"], { sandbox: "read-only", approval: "on-request", network: true }],
      [["--auto"], { sandbox: "workspace-write", approval: "never", network: false }],
      [["--dangerously-bypass-sandbox"], { sandbox: "danger-full-access", approval: "never", network: false }],
    ];
    for (const [flags, safety] of cases) {
      const terminal = io();
      expect(await runCli(["exec", "--driver", "stub", "--no-persist", "--json", ...flags, "x"], terminal)).toBe(0);
      expect(JSON.parse(terminal.stdout[0] ?? "{}")).toMatchObject({ type: "thread.started", safety });
    }
  });

  it("needs a connection for the native driver", async () => {
    const previous = { url: process.env.APORISA_BASE_URL, key: process.env.APORISA_API_KEY };
    process.env.APORISA_BASE_URL = "";
    process.env.APORISA_API_KEY = "";
    try {
      const terminal = io();
      const code = await runCli(["exec", "x"], terminal);
      // Either no .env exists (exit 2 with a hint) or a developer's .env points somewhere.
      if (code === 2) expect(terminal.stderr.join("")).toContain("set APORISA_BASE_URL and APORISA_API_KEY");
    } finally {
      process.env.APORISA_BASE_URL = previous.url ?? "";
      process.env.APORISA_API_KEY = previous.key ?? "";
      if (previous.url === undefined) delete process.env.APORISA_BASE_URL;
      if (previous.key === undefined) delete process.env.APORISA_API_KEY;
    }
  });
});

describe("rendering", () => {
  it("streams text to stdout and activity to stderr", () => {
    const out: string[] = [];
    const err: string[] = [];
    const render = renderer({ out: (text) => out.push(text), err: (text) => err.push(text) }, { json: false, showReasoning: false, color: false });
    render({ type: "item.delta", turnId: "t", itemId: "m", kind: "text", delta: "Hi" });
    render({ type: "item.delta", turnId: "t", itemId: "r", kind: "reasoning", delta: "secret plan" });
    render({ type: "tool.started", turnId: "t", callId: "c", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la" }) });
    render({
      type: "tool.completed",
      turnId: "t",
      callId: "c",
      name: "exec_command",
      success: true,
      output: "x",
      details: { kind: "command", command: "ls -la", cwd: "/", exitCode: 0, sessionId: null, wallTimeMs: 1200, sandboxed: true, escalated: false },
    });
    expect(out.join("")).toBe("Hi\n");
    expect(err.join("")).toBe("▶ $ ls -la\n  ✓ exit 0 (1.2s)\n");
  });

  it("asks clear approval questions and parses the answers", () => {
    const escalation = { kind: "command" as const, command: "npm install", cwd: "/w", reason: "escalation" as const, sandboxed: false, justification: "Install the dependencies?", rememberPrefixes: [["npm", "install"]] };
    expect(approvalQuestion(escalation)).toBe(
      "The model asks to run this command outside the sandbox in /w?\n  Install the dependencies?\n  $ npm install\n[y] yes  [a] yes, and allow `npm install` for this session  [N] no: ",
    );
    const dangerous = { kind: "command" as const, command: "rm -rf build", cwd: "/w", reason: "dangerous" as const, sandboxed: true, rememberPrefixes: null };
    expect(approvalQuestion(dangerous)).toBe("This command looks destructive (inside the sandbox) in /w?\n  $ rm -rf build\n[y] yes  [N] no: ");
    const patchRequest = { kind: "patch" as const, cwd: "/w", changes: [{ path: "a", kind: "update" as const, movePath: "b" }], reason: "outside_workspace" as const, paths: ["/x/b"] };
    expect(approvalQuestion(patchRequest)).toContain("writes outside the workspace or into a protected directory (/x/b):\n  update a -> b\n");
    expect(parseApproval("Y", escalation)).toBe("approved");
    expect(parseApproval("a", escalation)).toBe("approved_for_session");
    expect(parseApproval("a", dangerous)).toBe("denied");
    expect(parseApproval("", escalation)).toBe("denied");
  });
});
