// What a command did, for activity summaries in the UI ("Read files, ran commands";
// DEVELOPMENT_PLAN.md 10.3). A simplified take on codex's parse_command (protocol
// ParsedCommand: Read / ListFiles / Search / Unknown): built on the F3 splitter, it skips
// `cd dir &&` prefixes and filters after a pipe, and falls back to "run" for anything else.
import { parseCommand } from "./safety/shell.ts";

export type CommandAction =
  | { kind: "read"; path: string }
  | { kind: "search"; query: string | null; path: string | null }
  | { kind: "list"; path: string | null }
  | { kind: "run"; command: string };

const READERS = new Set(["cat", "nl", "head", "tail", "less", "more", "bat"]);
const SEARCHERS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);
const LISTERS = new Set(["ls", "tree", "fd"]);
/** Commands that only filter their input when they follow a pipe. */
const FILTERS = new Set(["head", "tail", "wc", "sort", "uniq", "cut", "tr", "grep", "rg", "sed", "awk", "nl", "cat", "less", "more", "column", "xargs"]);
/** Flags of the search tools that take a value (so the value is not the query or path). */
const SEARCH_VALUE_FLAGS = new Set(["-e", "-f", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "--context", "--include", "--exclude", "--exclude-dir", "-d", "--max-depth"]);
const NUMBER = /^\d+$/;

function basename(program: string): string {
  return program.slice(program.lastIndexOf("/") + 1);
}

/** Positional arguments, skipping flags (and the values of flags that take one). */
function operands(args: readonly string[], valueFlags: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--") {
      out.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function classifySegment(argv: readonly string[]): CommandAction[] | null {
  const program = basename(argv[0] ?? "");
  const args = argv.slice(1);
  if (READERS.has(program)) {
    // head -n 20 file / tail -20 file: numeric values are not files.
    const files = operands(args, new Set(["-n", "-c"])).filter((arg) => !NUMBER.test(arg));
    return files.length > 0 ? files.map((path) => ({ kind: "read", path })) : null;
  }
  if (program === "sed") {
    if (!args.includes("-n") || args.some((arg) => arg.startsWith("-i"))) return null;
    const [, ...files] = operands(args, new Set(["-e"]));
    return files.length > 0 ? files.map((path) => ({ kind: "read", path })) : null;
  }
  if (SEARCHERS.has(program)) {
    if (program === "rg" && args.includes("--files")) {
      return [{ kind: "list", path: operands(args, SEARCH_VALUE_FLAGS)[0] ?? null }];
    }
    const explicit = args.findIndex((arg) => arg === "-e");
    const positional = operands(args, SEARCH_VALUE_FLAGS);
    const query = explicit >= 0 ? (args[explicit + 1] ?? null) : (positional.shift() ?? null);
    return [{ kind: "search", query, path: positional[0] ?? null }];
  }
  if (program === "find") {
    const nameFlag = args.findIndex((arg) => arg === "-name" || arg === "-iname" || arg === "-path");
    if (args.some((arg) => ["-exec", "-execdir", "-delete", "-ok"].includes(arg))) return null;
    const path = args[0] && !args[0].startsWith("-") ? args[0] : null;
    return nameFlag >= 0 ? [{ kind: "search", query: args[nameFlag + 1] ?? null, path }] : [{ kind: "list", path }];
  }
  if (LISTERS.has(program)) {
    return [{ kind: "list", path: operands(args, new Set(["-L", "-I", "-d", "-e", "-t"]))[0] ?? null }];
  }
  return null;
}

/** The actions of one command line, in order. Anything unrecognized is a single "run". */
export function classifyCommand(command: string): CommandAction[] {
  const run: CommandAction[] = [{ kind: "run", command: command.trim() }];
  const parsed = parseCommand(command);
  if (!parsed.simple || parsed.segments.length === 0) return run;
  const actions: CommandAction[] = [];
  for (const [index, segment] of parsed.segments.entries()) {
    const program = basename(segment[0] ?? "");
    if (program === "cd" || program === "pushd" || program === "true") continue;
    const afterPipe = index > 0 && (parsed.separators[index - 1] === "|" || parsed.separators[index - 1] === "|&");
    if (afterPipe && FILTERS.has(program)) continue;
    if (program === "echo" && parsed.segments.length > 1) continue; // section labels between reads
    const classified = classifySegment(segment);
    if (!classified) return run;
    actions.push(...classified);
  }
  return actions.length > 0 ? actions : run;
}

export type ActivityKind = "read" | "search" | "list" | "run" | "edit" | "image" | "plan" | "stdin" | "other";
