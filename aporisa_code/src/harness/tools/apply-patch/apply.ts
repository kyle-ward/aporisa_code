// Applying parsed hunks, ported from openai/codex (Apache-2.0, Copyright 2025 OpenAI):
// codex-rs/apply-patch/src/seek_sequence.rs, file_update.rs (NormalizeToLf mode, codex's
// default) and lib.rs. One deliberate difference: codex writes hunk by hunk; here every
// change is computed in memory first and nothing is written unless the whole patch
// applies (DEVELOPMENT_PLAN.md 5.2).
import type { HostFileSystem } from "../../../host/index.ts";
import { dirname, resolve } from "../../paths.ts";
import type { FileChange } from "../types.ts";
import type { Hunk, UpdateFileChunk } from "./parser.ts";

export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchApplyError";
  }
}

const PUNCTUATION: Record<string, string> = {
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", "　": " ",
};

function normalise(line: string): string {
  let out = "";
  for (const char of line.trim()) out += PUNCTUATION[char] ?? char;
  return out;
}

/**
 * Finds `pattern` in `lines` at or after `start`: exact, then ignoring trailing
 * whitespace, then ignoring surrounding whitespace, then with typographic punctuation
 * folded to ASCII. With `eof`, the search starts where the pattern would end the file.
 */
export function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;
  const searchStart = eof ? lines.length - pattern.length : start;
  const passes: ((line: string) => string)[] = [(line) => line, (line) => line.trimEnd(), (line) => line.trim(), normalise];
  for (const view of passes) {
    for (let index = searchStart; index <= lines.length - pattern.length; index += 1) {
      if (pattern.every((expected, offset) => view(lines[index + offset] ?? "") === view(expected))) return index;
    }
  }
  return null;
}

type Replacement = [start: number, oldLength: number, newLines: string[]];

function computeReplacements(lines: readonly string[], path: string, chunks: readonly UpdateFileChunk[]): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== null) {
      const found = seekSequence(lines, [chunk.changeContext], lineIndex, false);
      if (found === null) throw new PatchApplyError(`Failed to find context '${chunk.changeContext}' in ${path}`);
      lineIndex = found + 1;
    }
    if (chunk.oldLines.length === 0) {
      // Pure insertion: at the end of the file (before a trailing empty line).
      const at = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      replacements.push([at, 0, [...chunk.newLines]]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    if (found === null && pattern[pattern.length - 1] === "") {
      // The trailing empty line stands for the file's final newline; retry without it.
      pattern = pattern.slice(0, -1);
      if (newLines[newLines.length - 1] === "") newLines = newLines.slice(0, -1);
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (found === null) throw new PatchApplyError(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    replacements.push([found, pattern.length, [...newLines]]);
    lineIndex = found + pattern.length;
  }
  return replacements.sort((a, b) => a[0] - b[0]);
}

/** New contents of a file after its update chunks (lines normalized to LF, final newline). */
export function deriveNewContents(original: string, path: string, chunks: readonly UpdateFileChunk[]): string {
  const lines = original.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const replacements = computeReplacements(lines, path, chunks);
  for (const [start, oldLength, newLines] of [...replacements].reverse()) lines.splice(start, oldLength, ...newLines);
  if (lines[lines.length - 1] !== "") lines.push("");
  return lines.join("\n");
}

export interface PlannedPatch {
  /** Final contents per absolute path; null deletes the file. Applied in insertion order. */
  writes: Map<string, string | null>;
  changes: FileChange[];
}

/**
 * Computes every file's final state without touching the disk. Later hunks see the
 * effect of earlier ones on the same file. Add File replaces an existing file, as in codex.
 */
export async function planPatch(hunks: readonly Hunk[], cwd: string, fs: HostFileSystem): Promise<PlannedPatch> {
  if (hunks.length === 0) throw new PatchApplyError("No files were modified.");
  const writes = new Map<string, string | null>();
  const changes: FileChange[] = [];

  const current = async (path: string, display: string, purpose: string): Promise<string> => {
    if (writes.has(path)) {
      const pending = writes.get(path);
      if (pending === null || pending === undefined) throw new PatchApplyError(`Failed to ${purpose} ${display}: the patch already deleted it`);
      return pending;
    }
    const entry = await fs.stat(path);
    if (!entry) throw new PatchApplyError(`Failed to ${purpose} ${display}: no such file`);
    if (entry.kind !== "file") throw new PatchApplyError(`Failed to ${purpose} ${display}: not a regular file`);
    return fs.readText(path);
  };

  for (const hunk of hunks) {
    const path = resolve(cwd, hunk.path);
    if (hunk.type === "add") {
      const entry = writes.has(path) ? null : await fs.stat(path);
      if (entry && entry.kind !== "file") throw new PatchApplyError(`Failed to add ${hunk.path}: a directory or special file is in the way`);
      writes.set(path, hunk.contents);
      changes.push({ path: hunk.path, kind: "add" });
    } else if (hunk.type === "delete") {
      await current(path, hunk.path, "delete");
      writes.set(path, null);
      changes.push({ path: hunk.path, kind: "delete" });
    } else {
      const contents = deriveNewContents(await current(path, hunk.path, "update"), hunk.path, hunk.chunks);
      if (hunk.movePath !== null) {
        const destination = resolve(cwd, hunk.movePath);
        writes.set(path, null);
        writes.delete(destination); // keep insertion order: the destination is written after the delete
        writes.set(destination, contents);
        changes.push({ path: hunk.path, kind: "update", movePath: hunk.movePath });
      } else {
        writes.set(path, contents);
        changes.push({ path: hunk.path, kind: "update" });
      }
    }
  }
  return { writes, changes };
}

/** Writes a planned patch, creating missing parent directories. */
export async function commitPatch(plan: PlannedPatch, fs: HostFileSystem): Promise<void> {
  for (const [path, contents] of plan.writes) {
    if (contents === null) {
      if (await fs.stat(path)) await fs.removeFile(path);
      continue;
    }
    await fs.mkdir(dirname(path));
    await fs.writeFile(path, contents);
  }
}

/** codex's summary: `Success. Updated the following files:` then A / M / D lines. */
export function summarize(changes: readonly FileChange[]): string {
  const added = changes.filter((change) => change.kind === "add").map((change) => `A ${change.path}`);
  const modified = changes.filter((change) => change.kind === "update").map((change) => `M ${change.movePath ?? change.path}`);
  const deleted = changes.filter((change) => change.kind === "delete").map((change) => `D ${change.path}`);
  return ["Success. Updated the following files:", ...added, ...modified, ...deleted].join("\n");
}
