// A deliberately conservative shell command splitter (F3; DEVELOPMENT_PLAN.md section 9).
// codex parses commands with tree-sitter-bash; here a small tokenizer splits at control
// operators and marks anything it does not fully understand as complex. Complex commands
// never match remembered approvals or the read-only list, so the only effect of an
// imperfect parse is an extra question to the user.

export interface ParsedCommand {
  /** Simple commands (argv) separated by |, ||, &&, ;, & or newlines. */
  segments: string[][];
  /** The operator after each segment but the last (`|`, `&&`, `||`, `;`, `&`, `|&` or newline). */
  separators: string[];
  /**
   * True when the text uses nothing beyond words, quotes and control operators: no
   * expansions ($, backticks), redirections, subshells or groups, globs, comments,
   * leading assignments or unterminated quotes.
   */
  simple: boolean;
}

const OPERATOR_START = new Set(["|", "&", ";", "\n"]);
const GLOB = new Set(["*", "?", "["]);
const COMPLEX = new Set(["<", ">", "(", ")", "`", "{", "}"]);

export function parseCommand(text: string): ParsedCommand {
  const segments: string[][] = [];
  const separators: string[] = [];
  let current: string[] = [];
  let word = "";
  let inWord = false;
  let simple = true;
  const endWord = () => {
    if (inWord) current.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = (separator?: string) => {
    endWord();
    if (current.length > 0) {
      segments.push(current);
      if (separator !== undefined) separators.push(separator);
    } else if (separator !== undefined && separators.length > 0) {
      separators[separators.length - 1] = separator;
    }
    current = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close < 0) {
        simple = false;
        word += text.slice(index + 1);
        inWord = true;
        break;
      }
      word += text.slice(index + 1, close);
      inWord = true;
      index = close;
      continue;
    }
    if (char === '"') {
      let closed = false;
      for (index += 1; index < text.length; index += 1) {
        const inner = text[index] as string;
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === "$" || inner === "`") simple = false;
        if (inner === "\\" && index + 1 < text.length && '$`"\\\n'.includes(text[index + 1] as string)) {
          index += 1;
          word += text[index];
          continue;
        }
        word += inner;
      }
      if (!closed) simple = false;
      inWord = true;
      continue;
    }
    if (char === "\\") {
      if (index + 1 < text.length) {
        index += 1;
        if (text[index] !== "\n") word += text[index];
        inWord = true;
      }
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    if (OPERATOR_START.has(char)) {
      // &&, ||, |, |&, ;, ;;, &, newline: all separate commands.
      const next = text[index + 1];
      let operator = char;
      if ((char === "&" || char === "|") && (next === char || (char === "|" && next === "&"))) {
        operator = char + next;
        index += 1;
      }
      if (char === "&" && next === ">") simple = false; // &> redirection
      endSegment(operator);
      continue;
    }
    if (char === "#" && !inWord) {
      simple = false;
      const newline = text.indexOf("\n", index);
      if (newline < 0) break;
      index = newline - 1;
      continue;
    }
    if (char === "$" || COMPLEX.has(char) || GLOB.has(char)) simple = false;
    if (char === "~" && !inWord) simple = false;
    if (char === "=" && !inWord && current.length === 0) simple = false;
    word += char;
    inWord = true;
    if (char === "=" && current.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=$/.test(word)) simple = false; // FOO=bar cmd
  }
  endSegment();
  separators.length = Math.max(0, segments.length - 1);
  return { segments, separators, simple };
}

function basename(program: string): string {
  return program.slice(program.lastIndexOf("/") + 1);
}

/** codex: rm with -f in any flag group (before `--`) or --force. */
function rmForces(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--force") return true;
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("f")) return true;
  }
  return false;
}

const MAX_WRAPPER_DEPTH = 8;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * codex's dangerous-command heuristic (shell-command/src/command_safety/
 * is_dangerous_command.rs): forced rm, also behind sudo, env and `sh -c` wrappers.
 * Dangerous commands always need approval, and are refused when approvals are off.
 */
export function isDangerous(argv: readonly string[], depth = 0): boolean {
  if (depth > MAX_WRAPPER_DEPTH) return true;
  const program = argv[0] === undefined ? "" : basename(argv[0]);
  const rest = argv.slice(1);
  if (program === "rm") return rmForces(rest);
  if (program === "sudo") return isDangerous(rest, depth + 1);
  if (program === "env") {
    let index = 0;
    while (index < rest.length) {
      const arg = rest[index] as string;
      if (arg === "--") {
        index += 1;
        break;
      }
      if (arg === "-i" || arg === "--ignore-environment" || /^[^-=][^=]*=/.test(arg)) {
        index += 1;
        continue;
      }
      break;
    }
    return isDangerous(rest.slice(index), depth + 1);
  }
  if (SHELLS.has(program)) {
    const flag = rest.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    const script = flag >= 0 ? rest[flag + 1] : undefined;
    if (script !== undefined) return commandIsDangerous(script, depth + 1);
  }
  return false;
}

export function commandIsDangerous(text: string, depth = 0): boolean {
  const parsed = parseCommand(text);
  if (parsed.segments.some((segment) => isDangerous(segment, depth))) return true;
  // A complex command may hide a forced rm the splitter could not isolate.
  return !parsed.simple && /(^|[\s;&|(`$])(sudo\s+)?(\S*\/)?rm\s+([^;&|]*\s)?(-[A-Za-z]*f|--force)/.test(text);
}

const READ_ONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "grep", "rg", "which", "file", "stat",
  "nl", "sort", "uniq", "cut", "tr", "diff", "cmp", "du", "df", "date", "whoami", "uname", "basename", "dirname", "realpath", "true",
]);
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const GIT_READ_ONLY = new Set(["status", "log", "diff", "show", "blame", "rev-parse", "ls-files"]);

/** Commands that only read (the `untrusted` policy runs these without asking). */
export function isReadOnly(argv: readonly string[]): boolean {
  const program = argv[0] === undefined ? "" : basename(argv[0]);
  const rest = argv.slice(1);
  if (READ_ONLY_PROGRAMS.has(program)) return !(program === "sort" && rest.some((arg) => arg === "-o" || arg.startsWith("--output")));
  if (program === "find") return !rest.some((arg) => FIND_WRITES.has(arg));
  if (program === "sed") return rest.includes("-n") && !rest.some((arg) => arg.startsWith("-i") || arg === "--in-place");
  if (program === "git") return GIT_READ_ONLY.has(rest[0] ?? "") && !rest.some((arg) => arg === "--output" || arg.startsWith("--output="));
  return false;
}

/** Programs whose second word is a subcommand worth remembering separately. */
const SUBCOMMAND_PROGRAMS = new Set([
  "git", "npm", "pnpm", "yarn", "npx", "bun", "cargo", "go", "pip", "pip3", "uv", "poetry", "conda",
  "docker", "brew", "gh", "kubectl", "swift", "make", "gradle", "mvn", "dotnet", "rustup",
]);

/**
 * The prefix an "allow for this session" approval remembers for one simple command: the
 * program plus its subcommand for tools like git and npm (`git commit`, `npm install`),
 * otherwise the program alone (`curl`, `python3`).
 */
export function rulePrefix(argv: readonly string[]): string[] {
  const [program, second] = argv;
  if (program === undefined) return [];
  const name = basename(program);
  return SUBCOMMAND_PROGRAMS.has(name) && second !== undefined && /^[a-z][a-z0-9-]*$/.test(second) ? [program, second] : [program];
}
