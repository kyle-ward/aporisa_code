// Patch parser, ported from openai/codex (Apache-2.0, Copyright 2025 OpenAI):
// codex-rs/apply-patch/src/parser.rs and streaming_parser.rs. Grammar:
// codex-rs/core/assets/tools/apply_patch.lark. Lenient mode as in codex: the patch may be
// wrapped in a `<<'EOF'` heredoc. The `*** Environment ID:` extension is not supported.

export const BEGIN_PATCH = "*** Begin Patch";
export const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";
const CHANGE_CONTEXT = "@@ ";
const EMPTY_CHANGE_CONTEXT = "@@";

export interface UpdateFileChunk {
  /** A line (usually a function or class header) to find before matching old_lines. */
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath: string | null; chunks: UpdateFileChunk[] };

export class PatchParseError extends Error {
  constructor(message: string, lineNumber?: number) {
    super(lineNumber === undefined ? `invalid patch: ${message}` : `invalid hunk at line ${lineNumber}, ${message}`);
    this.name = "PatchParseError";
  }
}

const HEADER_HINT = "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";
const LINE_HINT = "Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)";

export function parsePatch(patch: string): Hunk[] {
  const lines = patch.trim().split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const parser = new Parser();
  const body = checkBoundaries(lines);
  body.forEach((line, index) => {
    // Like codex's finish(): the final line ends the patch when it trims to the marker.
    if (index === body.length - 1 && line.trim() === END_PATCH) parser.end();
    else parser.line(line);
  });
  return parser.finish();
}

function checkBoundariesStrict(lines: string[]): string[] {
  const first = lines[0]?.trim();
  const last = lines[lines.length - 1]?.trim();
  if (first === BEGIN_PATCH && last === END_PATCH) return lines;
  if (first !== BEGIN_PATCH) throw new PatchParseError("The first line of the patch must be '*** Begin Patch'");
  throw new PatchParseError("The last line of the patch must be '*** End Patch'");
}

function checkBoundaries(lines: string[]): string[] {
  try {
    return checkBoundariesStrict(lines);
  } catch (error) {
    const first = lines[0];
    const last = lines[lines.length - 1] ?? "";
    if ((first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith("EOF") && lines.length >= 4) {
      return checkBoundariesStrict(lines.slice(1, -1));
    }
    throw error;
  }
}

type Mode = "not_started" | "started" | "add" | "delete" | "update" | "ended";

function emptyChunk(changeContext: string | null = null): UpdateFileChunk {
  return { changeContext, oldLines: [], newLines: [], isEndOfFile: false };
}

class Parser {
  private mode: Mode = "not_started";
  private readonly hunks: Hunk[] = [];
  private lineNumber = 0;
  private updateHunkLine = 0;

  line(line: string): void {
    this.lineNumber += 1;
    this.process(line);
  }

  end(): void {
    this.lineNumber += 1;
    this.ensureUpdateNotEmpty(END_PATCH);
    this.mode = "ended";
  }

  finish(): Hunk[] {
    if (this.mode !== "ended") throw new PatchParseError("The last line of the patch must be '*** End Patch'");
    return this.hunks;
  }

  private lastUpdate(): Extract<Hunk, { type: "update" }> | null {
    const last = this.hunks[this.hunks.length - 1];
    return last?.type === "update" ? last : null;
  }

  private ensureUpdateNotEmpty(line: string): void {
    const update = this.lastUpdate();
    if (!update || this.mode !== "update") return;
    if (update.chunks.length === 0) {
      throw new PatchParseError(`Update file hunk for path '${update.path}' is empty`, this.updateHunkLine);
    }
    const last = update.chunks[update.chunks.length - 1];
    if (last && last.oldLines.length === 0 && last.newLines.length === 0) {
      if (line === END_PATCH) throw new PatchParseError("Update hunk does not contain any lines", this.lineNumber);
      throw new PatchParseError(`Unexpected line found in update hunk: '${line}'. ${LINE_HINT}`, this.lineNumber);
    }
  }

  /** Hunk headers and the end marker; true when the line was one of them. */
  private header(text: string): boolean {
    if (text === END_PATCH) {
      this.ensureUpdateNotEmpty(text);
      this.mode = "ended";
      return true;
    }
    if (text.startsWith(ADD_FILE)) {
      this.ensureUpdateNotEmpty(text);
      this.hunks.push({ type: "add", path: text.slice(ADD_FILE.length), contents: "" });
      this.mode = "add";
      return true;
    }
    if (text.startsWith(DELETE_FILE)) {
      this.ensureUpdateNotEmpty(text);
      this.hunks.push({ type: "delete", path: text.slice(DELETE_FILE.length) });
      this.mode = "delete";
      return true;
    }
    if (text.startsWith(UPDATE_FILE)) {
      this.ensureUpdateNotEmpty(text);
      this.hunks.push({ type: "update", path: text.slice(UPDATE_FILE.length), movePath: null, chunks: [] });
      this.mode = "update";
      this.updateHunkLine = this.lineNumber;
      return true;
    }
    return false;
  }

  private process(line: string): void {
    const trimmed = line.trim();
    switch (this.mode) {
      case "not_started":
        if (trimmed === BEGIN_PATCH) {
          this.mode = "started";
          return;
        }
        throw new PatchParseError("The first line of the patch must be '*** Begin Patch'");
      case "started":
      case "delete":
        if (this.header(trimmed)) return;
        throw new PatchParseError(`'${trimmed}' is not a valid hunk header. ${HEADER_HINT}`, this.lineNumber);
      case "add": {
        if (this.header(trimmed)) return;
        const last = this.hunks[this.hunks.length - 1];
        if (line.startsWith("+") && last?.type === "add") {
          last.contents += `${line.slice(1)}\n`;
          return;
        }
        throw new PatchParseError(`'${trimmed}' is not a valid hunk header. ${HEADER_HINT}`, this.lineNumber);
      }
      case "update":
        this.updateLine(line);
        return;
      case "ended":
        if (trimmed === "") return;
        throw new PatchParseError("The last line of the patch must be '*** End Patch'");
    }
  }

  private updateLine(line: string): void {
    const text = line.trimEnd();
    if (this.header(text)) return;
    const update = this.lastUpdate();
    if (!update) throw new PatchParseError(`Unexpected line found in update hunk: '${line}'. ${LINE_HINT}`, this.lineNumber);
    const chunks = update.chunks;
    const last = (): UpdateFileChunk => {
      let chunk = chunks[chunks.length - 1];
      if (!chunk) {
        chunk = emptyChunk();
        chunks.push(chunk);
      }
      return chunk;
    };
    const lastChunk = chunks[chunks.length - 1];
    const lastIsEmpty = lastChunk !== undefined && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0;
    const isContextMarker = text === EMPTY_CHANGE_CONTEXT || text.startsWith(CHANGE_CONTEXT);

    if (lastChunk?.isEndOfFile) {
      if (text === "") return;
      if (!isContextMarker) {
        throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${line}'`, this.lineNumber);
      }
    }
    if (chunks.length === 0 && update.movePath === null && text.startsWith(MOVE_TO)) {
      update.movePath = text.slice(MOVE_TO.length);
      return;
    }
    if (isContextMarker && lastIsEmpty) {
      throw new PatchParseError(`Unexpected line found in update hunk: '${line}'. ${LINE_HINT}`, this.lineNumber);
    }
    if (text === EMPTY_CHANGE_CONTEXT) {
      chunks.push(emptyChunk());
      return;
    }
    if (text.startsWith(CHANGE_CONTEXT)) {
      chunks.push(emptyChunk(text.slice(CHANGE_CONTEXT.length)));
      return;
    }
    if (text === END_OF_FILE) {
      if (lastIsEmpty) throw new PatchParseError("Update hunk does not contain any lines", this.lineNumber);
      if (lastChunk) lastChunk.isEndOfFile = true;
      return;
    }
    if (line === "") {
      const chunk = last();
      chunk.oldLines.push("");
      chunk.newLines.push("");
      return;
    }
    if (line.startsWith(" ")) {
      const chunk = last();
      chunk.oldLines.push(line.slice(1));
      chunk.newLines.push(line.slice(1));
      return;
    }
    if (line.startsWith("+")) {
      last().newLines.push(line.slice(1));
      return;
    }
    if (line.startsWith("-")) {
      last().oldLines.push(line.slice(1));
      return;
    }
    if (lastChunk && !lastIsEmpty) {
      throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${line}'`, this.lineNumber);
    }
    throw new PatchParseError(`Unexpected line found in update hunk: '${line}'. ${LINE_HINT}`, this.lineNumber);
  }
}
