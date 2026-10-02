// An app started from Finder or the Dock gets launchd's minimal environment (PATH is
// /usr/bin:/bin:/usr/sbin:/sbin), not what the user's terminal has: tools set up in
// ~/.zshrc (conda, nvm, pyenv) would be missing. Like VS Code, the app asks the user's shell
// once at startup, as an interactive login shell, and adopts its environment.
import { execFile } from "node:child_process";

const START = "__APORISA_ENV_START__";
const END = "__APORISA_ENV_END__";
/** Shell bookkeeping that must not leak into the app's environment. */
const SKIP = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "ZDOTDIR"]);

/** Parses `env -0` output framed by the markers (shell startup files may print around it). */
export function parseEnvironment(output: string): Record<string, string> | null {
  const start = output.indexOf(START);
  const end = output.lastIndexOf(END);
  if (start < 0 || end < start) return null;
  const environment: Record<string, string> = {};
  for (const entry of output.slice(start + START.length, end).split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    if (!SKIP.has(name)) environment[name] = entry.slice(separator + 1);
  }
  return environment;
}

/** The user's shell environment, or null when it could not be read within the timeout. */
export function resolveShellEnvironment(shell: string, timeoutMs = 10_000): Promise<Record<string, string> | null> {
  const script = `printf '%s' '${START}'; /usr/bin/env -0; printf '%s' '${END}'`;
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", script], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, APORISA_RESOLVING_SHELL_ENV: "1" } }, (error, stdout) => {
      resolve(error && !stdout ? null : parseEnvironment(String(stdout)));
    });
  });
}
