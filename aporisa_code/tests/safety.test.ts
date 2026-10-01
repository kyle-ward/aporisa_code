import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessCommand,
  assessPatch,
  commandIsDangerous,
  isDenied,
  isReadOnly,
  isWritable,
  likelySandboxDenied,
  parseCommand,
  permissionsMessage,
  realPath,
  resolveSafety,
  rulePrefix,
  SessionRules,
  type SafetyPolicy,
} from "../src/harness/safety/index.ts";
import { NodeHost } from "../src/host/index.ts";

const host = new NodeHost({ shell: "/bin/sh" });
let root: string;

function policy(overrides: Partial<SafetyPolicy> = {}): SafetyPolicy {
  return {
    sandbox: "workspace-write",
    approval: "on-request",
    network: false,
    writableRoots: ["/w", "/private/tmp"],
    protectedNames: [".git", ".agents"],
    denyPaths: ["/Users/me/.ssh"],
    stripSecrets: true,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "aporisa-safety-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("command splitting", () => {
  it("splits at control operators and keeps quoted words intact", () => {
    expect(parseCommand("git status && npm test | tee out; echo 'a b' \"c d\" & ls\nwc -l")).toEqual({
      segments: [["git", "status"], ["npm", "test"], ["tee", "out"], ["echo", "a b", "c d"], ["ls"], ["wc", "-l"]],
      simple: true,
    });
    expect(parseCommand("echo a\\ b || true").segments).toEqual([["echo", "a b"], ["true"]]);
  });

  it("marks anything it does not fully understand as complex", () => {
    for (const text of ["echo $HOME", "echo `id`", "ls > out", "cat < in", "(cd x && ls)", "{ ls; }", "ls *.ts", "FOO=1 make", "echo 'open", "ls # note", "cat ~/x", 'echo "$(id)"', "ls &> out"]) {
      expect(parseCommand(text).simple, text).toBe(false);
    }
  });
});

describe("dangerous commands (codex cases)", () => {
  it("flags forced rm, also behind sudo, env and sh -c", () => {
    for (const text of ["rm -rf /", "rm -f x", "/bin/rm -fr /tmp/example", "rm -r -f x", "rm --force x", "rm x -f", "sudo rm -rf x", "env TARGET=x rm -rf x", "bash -lc 'rm -rf build'", "ls && rm -rf x", "echo $(rm -rf x)"]) {
      expect(commandIsDangerous(text), text).toBe(true);
    }
    for (const text of ["rm x", "rm -r x", "rm -- -f", "ls -f", "sudo ls", "git rm -r x", "echo rm -rf"]) {
      expect(commandIsDangerous(text), text).toBe(false);
    }
  });

  it("knows read-only commands and remembers the right prefix", () => {
    for (const argv of [["ls", "-la"], ["cat", "a"], ["sed", "-n", "1,5p", "f"], ["git", "diff"], ["find", ".", "-name", "x"], ["rg", "foo"]]) expect(isReadOnly(argv)).toBe(true);
    for (const argv of [["sed", "-i", "", "s/a/b/", "f"], ["find", ".", "-delete"], ["git", "commit"], ["touch", "x"], ["sort", "-o", "f", "f"]]) expect(isReadOnly(argv)).toBe(false);
    expect(rulePrefix(["git", "commit", "-m", "x"])).toEqual(["git", "commit"]);
    expect(rulePrefix(["npm", "install"])).toEqual(["npm", "install"]);
    expect(rulePrefix(["curl", "-s", "http://x"])).toEqual(["curl"]);
    expect(rulePrefix(["touch", "made"])).toEqual(["touch"]);
    expect(rulePrefix(["git", "-C", "x", "status"])).toEqual(["git"]);
  });
});

describe("command decisions", () => {
  it("runs plain commands in the sandbox under on-request and never", () => {
    const rules = new SessionRules();
    expect(assessCommand(policy(), rules, "npm test", false)).toEqual({ action: "run", sandboxed: true });
    expect(assessCommand(policy({ approval: "never" }), rules, "npm test", false)).toEqual({ action: "run", sandboxed: true });
  });

  it("asks for escalation, remembers it for the session, refuses it when approvals are off", () => {
    const rules = new SessionRules();
    expect(assessCommand(policy(), rules, "npm install && npm test", true)).toEqual({ action: "ask", sandboxed: false, reason: "escalation", prefixes: [["npm", "install"], ["npm", "test"]] });
    rules.rememberCommand([["npm", "install"], ["npm", "test"]], true);
    expect(assessCommand(policy(), rules, "npm test", true)).toEqual({ action: "run", sandboxed: false });
    expect(assessCommand(policy(), rules, "npm test > log", true)).toMatchObject({ action: "ask", prefixes: null });
    expect(assessCommand(policy({ approval: "never" }), rules, "npm install", true)).toMatchObject({ action: "refuse" });
  });

  it("always asks before destructive commands and refuses them without approvals", () => {
    const rules = new SessionRules();
    rules.rememberCommand([["rm"]], true);
    expect(assessCommand(policy(), rules, "rm -rf build", false)).toEqual({ action: "ask", sandboxed: true, reason: "dangerous", prefixes: null });
    expect(assessCommand(policy({ approval: "never" }), rules, "rm -rf build", false)).toMatchObject({ action: "refuse" });
  });

  it("asks for everything but read-only commands under untrusted", () => {
    const rules = new SessionRules();
    const untrusted = policy({ approval: "untrusted" });
    expect(assessCommand(untrusted, rules, "ls -la && git status", false)).toEqual({ action: "run", sandboxed: true });
    expect(assessCommand(untrusted, rules, "make", false)).toEqual({ action: "ask", sandboxed: true, reason: "untrusted", prefixes: [["make"]] });
    rules.rememberCommand([["make"]], false);
    expect(assessCommand(untrusted, rules, "make", false)).toEqual({ action: "run", sandboxed: true });
  });

  it("runs unsandboxed without a sandbox and still asks for destructive commands", () => {
    const rules = new SessionRules();
    const full = policy({ sandbox: "danger-full-access", writableRoots: [] });
    expect(assessCommand(full, rules, "npm install", true)).toEqual({ action: "run", sandboxed: false });
    expect(assessCommand(full, rules, "rm -rf x", false)).toMatchObject({ action: "ask", sandboxed: false });
  });
});

describe("paths and patches", () => {
  it("treats protected metadata and private locations as not writable", () => {
    const p = policy();
    expect(isWritable(p, "/w/src/a.ts")).toBe(true);
    expect(isWritable(p, "/w")).toBe(true);
    expect(isWritable(p, "/w/.git/config")).toBe(false);
    expect(isWritable(p, "/w/.git")).toBe(false);
    expect(isWritable(p, "/w/.github/x")).toBe(true);
    expect(isWritable(p, "/wx/a")).toBe(false);
    expect(isWritable(p, "/private/tmp/a")).toBe(true);
    expect(isDenied(p, "/Users/me/.ssh/id_ed25519")).toBe(true);
    expect(isWritable(policy({ sandbox: "danger-full-access" }), "/anywhere")).toBe(true);
    expect(isWritable(policy({ sandbox: "danger-full-access" }), "/Users/me/.ssh/x")).toBe(false);
  });

  it("asks before patches outside the workspace and refuses private paths", () => {
    const rules = new SessionRules();
    expect(assessPatch(policy(), rules, ["/w/a"])).toEqual({ action: "run" });
    expect(assessPatch(policy(), rules, ["/w/a", "/etc/x", "/w/.git/HEAD"])).toEqual({ action: "ask", reason: "outside_workspace", paths: ["/etc/x", "/w/.git/HEAD"] });
    expect(assessPatch(policy({ approval: "never" }), rules, ["/etc/x"])).toMatchObject({ action: "refuse" });
    expect(assessPatch(policy(), rules, ["/Users/me/.ssh/config"])).toMatchObject({ action: "refuse" });
    expect(assessPatch(policy({ approval: "untrusted" }), rules, ["/w/a"])).toEqual({ action: "ask", reason: "untrusted", paths: ["/w/a"] });
    rules.rememberPaths(["/etc/x"]);
    expect(assessPatch(policy(), rules, ["/etc/x"])).toEqual({ action: "run" });
  });

  it("resolves real paths through symlinks, also for files that do not exist yet", async () => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    expect(await realPath(host.fs, join(root, "link", "new", "file.txt"))).toBe(join(root, "real", "new", "file.txt"));
    expect(await realPath(host.fs, "/tmp/../tmp/x")).toBe("/private/tmp/x");
  });
});

describe("resolved policy", () => {
  it("defaults to workspace-write, no network, on-request and the private locations", async () => {
    const info = { ...host.info(), dataDir: join(root, "data") };
    const resolved = await resolveSafety({}, root, host.fs, info);
    expect(resolved).toMatchObject({ sandbox: "workspace-write", approval: "on-request", network: false, stripSecrets: true, protectedNames: [".git", ".agents", ".codex", ".aporisa"] });
    expect(resolved.writableRoots).toEqual([root, "/private/tmp", await realpath(tmpdir())]);
    expect(resolved.denyPaths).toEqual(expect.arrayContaining([join(await realpath(homedir()), ".ssh"), join(root, "data")]));
    expect((await resolveSafety({ tmpWritable: false }, root, host.fs, info)).writableRoots).toEqual([root]);
    expect((await resolveSafety({ sandbox: "read-only" }, root, host.fs, info)).writableRoots).toEqual([]);
  });

  it("tells the model its permissions", () => {
    expect(permissionsMessage(policy())).toContain('"sandbox_permissions": "require_escalated"');
    expect(permissionsMessage(policy())).toContain("Network access is disabled");
    expect(permissionsMessage(policy({ approval: "never" }))).toContain("Approvals are off");
    expect(permissionsMessage(policy({ approval: "never" }))).not.toContain("require_escalated");
    expect(permissionsMessage(policy({ sandbox: "danger-full-access" }))).toContain("without a sandbox");
  });

  it("recognizes likely sandbox denials", () => {
    expect(likelySandboxDenied(policy(), 1, "touch: x: Operation not permitted")).toBe(true);
    expect(likelySandboxDenied(policy(), 6, "curl: (6) Could not resolve host: example.com")).toBe(true);
    expect(likelySandboxDenied(policy({ network: true }), 6, "curl: (6) Could not resolve host: example.com")).toBe(false);
    expect(likelySandboxDenied(policy(), 0, "operation not permitted")).toBe(false);
    expect(likelySandboxDenied(policy(), 127, "sandbox: command not found")).toBe(false);
    expect(likelySandboxDenied(policy(), 1, "assertion failed")).toBe(false);
  });
});
