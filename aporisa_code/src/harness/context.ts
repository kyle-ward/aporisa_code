// The fixed start of every thread's input (DEVELOPMENT_PLAN.md 6.1): the environment
// context and the project's AGENTS.md files, as user messages in codex's formats
// (core/src/context/environment_context.rs, user_instructions.rs, agents_md.rs).
import type { HostFileSystem, HostInfo } from "../host/index.ts";
import type { InputItem } from "../protocol/index.ts";
import { basename, dirname } from "./paths.ts";
import { byteLength } from "./tools/index.ts";

/** codex's project_doc_max_bytes default. */
export const AGENTS_MD_MAX_BYTES = 32 * 1024;
export const AGENTS_MD = "AGENTS.md";

function userMessage(text: string): InputItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** YYYY-MM-DD in the given time zone. */
export function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function environmentContext(cwd: string, info: HostInfo, date: Date): InputItem {
  const lines = [
    "<environment_context>",
    `  <cwd>${escapeXml(cwd)}</cwd>`,
    `  <shell>${escapeXml(basename(info.shell))}</shell>`,
    `  <current_date>${localDate(date, info.timeZone)}</current_date>`,
    `  <timezone>${escapeXml(info.timeZone)}</timezone>`,
    "</environment_context>",
  ];
  return userMessage(lines.join("\n"));
}

/** The project root: the nearest ancestor (or cwd itself) containing `.git`; null if none. */
export async function projectRoot(cwd: string, fs: HostFileSystem): Promise<string | null> {
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (await fs.stat(`${directory === "/" ? "" : directory}/.git`)) return directory;
    if (directory === "/") return null;
  }
}

/**
 * AGENTS.md files from the project root down to `cwd` (only `cwd` outside a project),
 * concatenated in that order and capped at AGENTS_MD_MAX_BYTES.
 */
export async function loadAgentsMd(cwd: string, fs: HostFileSystem): Promise<string | null> {
  const root = (await projectRoot(cwd, fs)) ?? cwd;
  const directories: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    directories.unshift(directory);
    if (directory === root || directory === "/") break;
  }
  const parts: string[] = [];
  let remaining = AGENTS_MD_MAX_BYTES;
  for (const directory of directories) {
    if (remaining <= 0) break;
    const path = `${directory === "/" ? "" : directory}/${AGENTS_MD}`;
    const entry = await fs.stat(path);
    if (entry?.kind !== "file") continue;
    let text = (await fs.readText(path)).trim();
    if (text === "") continue;
    if (byteLength(text) > remaining) {
      const bytes = new TextEncoder().encode(text).subarray(0, remaining);
      text = new TextDecoder("utf-8").decode(bytes).replace(/�$/, "");
    }
    remaining -= byteLength(text);
    parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function agentsMdMessage(cwd: string, text: string): InputItem {
  return userMessage(`# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>`);
}

/** The thread's permissions (sandbox, network, approvals) as a developer message (F3). */
export function permissionsItem(text: string): InputItem {
  return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
}

/** The thread's fixed opening items; they never change for the life of the thread. */
export async function initialContext(cwd: string, fs: HostFileSystem, info: HostInfo, date: Date, permissions?: string): Promise<InputItem[]> {
  const items = [environmentContext(cwd, info, date)];
  if (permissions !== undefined) items.push(permissionsItem(permissions));
  const agents = await loadAgentsMd(cwd, fs);
  if (agents !== null) items.push(agentsMdMessage(cwd, agents));
  return items;
}
