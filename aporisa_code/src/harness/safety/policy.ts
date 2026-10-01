// Execution safety policy (F3; DEVELOPMENT_PLAN.md section 9), after codex's sandbox modes
// (protocol.rs SandboxPolicy) and approval policies (core/src/exec_policy.rs).
//
// Defaults adopted by the user on 2026-10-01: workspace-write, no network, on-request
// approvals, .git and project metadata read-only, private locations unreadable, secret
// environment variables stripped, approvals remembered for the session only.
import type { HostFileSystem, HostInfo, SandboxSpec } from "../../host/index.ts";
import { dirname, isAbsolute, normalize, resolve } from "../paths.ts";
import { commandIsDangerous, isReadOnly, parseCommand, rulePrefix, type ParsedCommand } from "./shell.ts";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export interface SafetyOptions {
  sandbox?: SandboxMode;
  approval?: ApprovalPolicy;
  /** Network for sandboxed commands (default false). */
  network?: boolean;
  /** Extra writable directories for workspace-write (absolute). */
  writableRoots?: string[];
  /** /tmp and $TMPDIR are writable under workspace-write (default true; codex's exclude flags). */
  tmpWritable?: boolean;
  /** Replaces the default unreadable locations (absolute or ~/...). */
  denyRead?: string[];
  /** Drop KEY / SECRET / TOKEN variables from commands' environment (default true). */
  stripSecrets?: boolean;
}

export interface SafetyPolicy {
  sandbox: SandboxMode;
  approval: ApprovalPolicy;
  network: boolean;
  /** Resolved (real) paths; empty for read-only and danger-full-access. */
  writableRoots: string[];
  protectedNames: string[];
  /** Resolved (real) paths. */
  denyPaths: string[];
  stripSecrets: boolean;
}

/** Read-only even inside writable roots (codex: .git, .agents, .codex; plus our own). */
export const PROTECTED_NAMES = [".git", ".agents", ".codex", ".aporisa"];
export const DEFAULT_DENY_READ = ["~/.ssh", "~/.gnupg", "~/.aws", "~/Library/Keychains"];

export const DEFAULT_SAFETY: Required<Pick<SafetyOptions, "sandbox" | "approval" | "network" | "stripSecrets">> = {
  sandbox: "workspace-write",
  approval: "on-request",
  network: false,
  stripSecrets: true,
};

/** Real path of `path`, resolving symlinks in the part that exists (the rest may not yet). */
export async function realPath(fs: HostFileSystem, path: string): Promise<string> {
  const absolute = normalize(path);
  const missing: string[] = [];
  for (let current = absolute; ; current = dirname(current)) {
    if (await fs.stat(current)) {
      const real = await fs.realpath(current);
      return missing.length === 0 ? real : normalize(`${real}/${missing.reverse().join("/")}`);
    }
    if (current === "/") return absolute;
    missing.push(current.slice(current.lastIndexOf("/") + 1));
  }
}

export async function resolveSafety(options: SafetyOptions, cwd: string, fs: HostFileSystem, info: HostInfo): Promise<SafetyPolicy> {
  const sandbox = options.sandbox ?? DEFAULT_SAFETY.sandbox;
  const expand = (path: string) => (path.startsWith("~/") ? `${info.homeDir}${path.slice(1)}` : path);
  const absolute = (path: string) => {
    const expanded = expand(path);
    if (!isAbsolute(expanded)) throw new Error(`safety paths must be absolute: ${path}`);
    return expanded;
  };
  const unique = (paths: string[]) => [...new Set(paths)];
  const writableRoots =
    sandbox === "workspace-write"
      ? unique(
          await Promise.all(
            [cwd, ...(options.tmpWritable === false ? [] : ["/tmp", info.tmpDir]), ...(options.writableRoots ?? []).map(absolute)].map((path) => realPath(fs, path)),
          ),
        )
      : [];
  const denyPaths = unique(await Promise.all([...(options.denyRead ?? DEFAULT_DENY_READ), info.dataDir].map((path) => realPath(fs, absolute(path)))));
  return {
    sandbox,
    approval: options.approval ?? DEFAULT_SAFETY.approval,
    network: options.network ?? DEFAULT_SAFETY.network,
    writableRoots,
    protectedNames: [...PROTECTED_NAMES],
    denyPaths,
    stripSecrets: options.stripSecrets ?? DEFAULT_SAFETY.stripSecrets,
  };
}

export function sandboxSpec(policy: SafetyPolicy): SandboxSpec | null {
  if (policy.sandbox === "danger-full-access") return null;
  return { writableRoots: policy.writableRoots, protectedNames: policy.protectedNames, denyPaths: policy.denyPaths, network: policy.network };
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

/** For a real path: is it unreadable (and unwritable) under the policy? */
export function isDenied(policy: SafetyPolicy, path: string): boolean {
  return policy.denyPaths.some((denied) => within(path, denied));
}

/** For a real path: may the sandbox write it? Always true without a sandbox. */
export function isWritable(policy: SafetyPolicy, path: string): boolean {
  if (isDenied(policy, path)) return false;
  if (policy.sandbox === "danger-full-access") return true;
  return policy.writableRoots.some(
    (root) => within(path, root) && !policy.protectedNames.some((name) => within(path, resolve(root, name))),
  );
}

/** Approvals remembered for the rest of the thread ("yes, for this session"). */
export class SessionRules {
  private readonly sandboxed = new Set<string>();
  private readonly unsandboxed = new Set<string>();
  private readonly paths = new Set<string>();

  rememberCommand(prefixes: readonly (readonly string[])[], unsandboxed: boolean): void {
    for (const prefix of prefixes) (unsandboxed ? this.unsandboxed : this.sandboxed).add(JSON.stringify(prefix));
  }

  /** Every segment starts with a remembered prefix (unsandboxed approvals cover sandboxed runs too). */
  allowsCommand(parsed: ParsedCommand, unsandboxed: boolean): boolean {
    if (!parsed.simple || parsed.segments.length === 0) return false;
    const pools = unsandboxed ? [this.unsandboxed] : [this.sandboxed, this.unsandboxed];
    return parsed.segments.every((segment) => {
      const prefix = rulePrefix(segment);
      return pools.some((pool) => pool.has(JSON.stringify(prefix)));
    });
  }

  rememberPaths(paths: readonly string[]): void {
    for (const path of paths) this.paths.add(path);
  }

  allowsPath(path: string): boolean {
    return this.paths.has(path);
  }
}

export type CommandReason = "escalation" | "dangerous" | "untrusted";

export type CommandAssessment =
  | { action: "run"; sandboxed: boolean }
  | { action: "ask"; sandboxed: boolean; reason: CommandReason; prefixes: string[][] | null }
  | { action: "refuse"; message: string };

/**
 * What to do with a command (codex render_decision_for_unmatched_command):
 * - dangerous commands (forced rm) always ask, and are refused when approvals are off;
 * - an escalation request (run outside the sandbox) asks, unless remembered; refused under `never`;
 * - `untrusted` asks for anything but read-only commands, unless remembered;
 * - otherwise the command runs, in the sandbox when there is one.
 */
export function assessCommand(policy: SafetyPolicy, rules: SessionRules, command: string, escalate: boolean): CommandAssessment {
  const parsed = parseCommand(command);
  const hasSandbox = policy.sandbox !== "danger-full-access";
  const unsandboxed = escalate || !hasSandbox;
  const prefixes = parsed.simple && parsed.segments.length > 0 ? parsed.segments.map(rulePrefix) : null;

  if (commandIsDangerous(command)) {
    if (policy.approval === "never") {
      return { action: "refuse", message: "This command looks destructive (for example a forced rm) and approvals are off, so it was not run. Use a safer command, or ask the user to run it." };
    }
    return { action: "ask", sandboxed: !unsandboxed, reason: "dangerous", prefixes: null };
  }
  if (escalate && hasSandbox) {
    if (policy.approval === "never") {
      return { action: "refuse", message: "Running outside the sandbox needs the user's approval, and approvals are off in this session; the command was not run. Work within the sandbox or tell the user what you need." };
    }
    if (rules.allowsCommand(parsed, true)) return { action: "run", sandboxed: false };
    return { action: "ask", sandboxed: false, reason: "escalation", prefixes };
  }
  if (policy.approval === "untrusted") {
    if (parsed.simple && parsed.segments.length > 0 && parsed.segments.every(isReadOnly)) return { action: "run", sandboxed: hasSandbox };
    if (rules.allowsCommand(parsed, unsandboxed)) return { action: "run", sandboxed: hasSandbox };
    return { action: "ask", sandboxed: hasSandbox, reason: "untrusted", prefixes };
  }
  return { action: "run", sandboxed: hasSandbox };
}

export type PatchAssessment =
  | { action: "run" }
  | { action: "ask"; reason: "outside_workspace" | "untrusted"; paths: string[] }
  | { action: "refuse"; message: string };

/** `paths` are the real paths a patch writes or deletes. */
export function assessPatch(policy: SafetyPolicy, rules: SessionRules, paths: readonly string[]): PatchAssessment {
  const denied = paths.filter((path) => isDenied(policy, path));
  if (denied.length > 0) return { action: "refuse", message: `These locations are private and cannot be written: ${denied.join(", ")}. The patch was not applied.` };
  const blocked = paths.filter((path) => !isWritable(policy, path) && !rules.allowsPath(path));
  if (blocked.length > 0) {
    if (policy.approval === "never") {
      return {
        action: "refuse",
        message: `These paths are outside the writable workspace (or in a protected directory such as .git), and approvals are off: ${blocked.join(", ")}. The patch was not applied.`,
      };
    }
    return { action: "ask", reason: "outside_workspace", paths: blocked };
  }
  if (policy.approval === "untrusted") {
    const unapproved = paths.filter((path) => !rules.allowsPath(path));
    if (unapproved.length > 0) return { action: "ask", reason: "untrusted", paths: unapproved };
  }
  return { action: "run" };
}

const DENIAL_HINTS = ["operation not permitted", "permission denied", "read-only file system", "sandbox"];
const NETWORK_HINTS = ["could not resolve host", "nodename nor servname", "enotfound", "getaddrinfo", "network is unreachable", "failed to connect", "couldn't connect", "name or service not known", "temporary failure in name resolution"];

/** codex denial.rs: a failed sandboxed command whose output smells of the sandbox. */
export function likelySandboxDenied(policy: SafetyPolicy, exitCode: number | null, output: string): boolean {
  if (exitCode === null || exitCode === 0 || exitCode === 126 || exitCode === 127) return false;
  const text = output.toLowerCase();
  if (DENIAL_HINTS.some((hint) => text.includes(hint))) return true;
  return !policy.network && NETWORK_HINTS.some((hint) => text.includes(hint));
}

/** The developer message telling the model its permissions (codex permissions templates). */
export function permissionsMessage(policy: SafetyPolicy): string {
  const lines = ["<permissions>"];
  if (policy.sandbox === "danger-full-access") {
    lines.push("Commands run without a sandbox, with the user's full permissions. Be careful with anything destructive.");
  } else {
    const writable = policy.sandbox === "workspace-write" ? "write only inside the working directory, /tmp and $TMPDIR" : "not write files at all";
    lines.push(
      `Commands run in a sandbox (${policy.sandbox}): they can read files, except a few private locations, and ${writable}.`,
      "`.git` and other metadata directories in the workspace are read-only, so staging and committing are not possible inside the sandbox.",
      `Network access is ${policy.network ? "enabled" : "disabled"} inside the sandbox.`,
    );
  }
  if (policy.approval === "never") {
    lines.push("Approvals are off: nothing can run outside these limits. If the task needs more, finish what you can and tell the user what is missing.");
  } else if (policy.sandbox !== "danger-full-access") {
    lines.push(
      'When a command needs more than the sandbox allows (network access, writing outside the workspace, git commit), call exec_command with "sandbox_permissions": "require_escalated" and a "justification": one short question asking the user to allow it. The command then runs outside the sandbox if the user approves.',
      'If a command fails because of the sandbox ("Operation not permitted", or a network error while network is disabled), rerun it that way. Do not try to work around the sandbox.',
    );
    if (policy.approval === "untrusted") lines.push("The user is asked before every command that is not read-only and before every patch.");
  }
  lines.push("</permissions>");
  return lines.join("\n");
}
