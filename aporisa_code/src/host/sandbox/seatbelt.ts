// macOS Seatbelt sandbox for commands (DEVELOPMENT_PLAN.md section 9, F3), after codex's
// codex-rs/sandboxing/src/seatbelt.rs: `/usr/bin/sandbox-exec -p <policy> -D<key>=<path>
// -- <argv>`. sandbox-exec applies the policy and then execs the command, so the process
// (and its group) is the command itself.
import type { SandboxSpec } from "../types.ts";
import { BASE_POLICY, NETWORK_POLICY, PREFERENCES_POLICY, TLS_TRUST_POLICY } from "./codex-policies.ts";

/** Only the system copy is trusted, never one found on PATH (codex). */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function checkPath(path: string): void {
  if (!path.startsWith("/")) throw new Error(`sandbox paths must be absolute: ${path}`);
  if (/["\n\0]/.test(path)) throw new Error(`unsupported character in sandbox path: ${JSON.stringify(path)}`);
}

/** Escapes a literal for a Seatbelt regex (POSIX extended syntax inside #"..."). */
export function regexLiteral(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, (char) => `\\${char}`);
}

export interface SeatbeltInvocation {
  policy: string;
  /** -D definitions referenced by the policy as (param "KEY"). */
  params: [string, string][];
}

export function seatbeltPolicy(spec: SandboxSpec): SeatbeltInvocation {
  for (const path of [...spec.writableRoots, ...spec.denyPaths]) checkPath(path);
  for (const name of spec.protectedNames) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error(`invalid protected name: ${name}`);
  }
  const params: [string, string][] = [];
  const sections = [
    BASE_POLICY,
    "; allow read-only file operations\n(allow file-read*)",
    // Resolves the per-user temporary directory (confstr DARWIN_USER_TEMP_DIR); without it
    // Python warns on every start. codex grants it only with network or restricted reads.
    '(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
  ];

  const protectedNames = spec.protectedNames.map(regexLiteral).join("|");
  spec.writableRoots.forEach((root, index) => {
    const key = `WRITABLE_ROOT_${index}`;
    params.push([key, root]);
    const base = root === "/" ? "" : root.replace(/\/+$/, "");
    const exclusion = protectedNames === "" ? "" : ` (require-not (regex #"^${regexLiteral(base)}/(${protectedNames})(/.*)?$"))`;
    sections.push(`(allow file-write* (require-all (subpath (param "${key}"))${exclusion}))`);
    // The root itself must not be deleted or replaced, even when its parent is writable.
    sections.push(`(deny file-write-unlink (require-all (literal (param "${key}")) (vnode-type DIRECTORY)))`);
  });

  if (spec.network) {
    sections.push(`(allow network-outbound)\n(allow network-inbound)\n${NETWORK_POLICY}${TLS_TRUST_POLICY}`);
  }
  sections.push(PREFERENCES_POLICY);
  sections.push('(deny mach-lookup (xpc-service-name-prefix ""))');

  // Denials come last so no broader allowance can reopen them.
  spec.denyPaths.forEach((path, index) => {
    const key = `DENIED_PATH_${index}`;
    params.push([key, path]);
    sections.push(`(deny file-read* file-write* (subpath (param "${key}")))`);
  });
  // These fcntls mutate files through read-only descriptors (codex): F_MAKECOMPRESSED,
  // F_TRANSFEREXTENTS.
  sections.push("(deny system-fcntl (fcntl-command 80 110))");
  return { policy: sections.join("\n"), params };
}

/** Arguments for SANDBOX_EXEC that run `argv` under `spec`. */
export function seatbeltArgs(spec: SandboxSpec, argv: readonly string[]): string[] {
  const { policy, params } = seatbeltPolicy(spec);
  return ["-p", policy, ...params.map(([key, value]) => `-D${key}=${value}`), "--", ...argv];
}
