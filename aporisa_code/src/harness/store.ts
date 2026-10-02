// Session record ("rollout", after codex's rollout/): one JSONL file per thread under
// <sessionsDir>/YYYY/MM/DD/, directories 0700 and files 0600 (DEVELOPMENT_PLAN.md 6.5).
// Since F4 the sessions of the only (implicit) profile live in
// <dataDir>/profiles/local/sessions (FD-22). It holds full content because resuming needs
// it; it is user data, not a log.
import type { HostFileSystem } from "../host/index.ts";
import { InputItem, type ReasoningEffort } from "../protocol/index.ts";
import type { ToolDetails } from "./tools/index.ts";

export const SESSION_FILE_MODE = 0o600;
export const SESSION_DIR_MODE = 0o700;
export const HARNESS_VERSION = "f4";
export const DEFAULT_PROFILE = "local";

export function profileDir(dataDir: string, profile = DEFAULT_PROFILE): string {
  return `${dataDir}/profiles/${profile}`;
}

export function defaultSessionsDir(dataDir: string): string {
  return `${profileDir(dataDir)}/sessions`;
}

export interface SafetySummary {
  sandbox: string;
  approval: string;
  network: boolean;
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  driver: string;
  /** Baseline effort when the thread started. */
  effort: ReasoningEffort;
  harnessVersion: string;
  /** Sandbox, approval and network settings the thread started with (F3; absent before). */
  safety?: SafetySummary;
  /** How many opening items (environment, permissions, AGENTS.md) the history starts with (F4). */
  initialItemCount?: number;
  /** Reference directories the thread started with (F4.5; absent before = none). */
  references?: string[];
  /**
   * The owning app's grouping (F4.5): the project id, or null for a chat without a project.
   * Absent in sessions written before F4.5 or by the CLI. The harness never reads it.
   */
  projectId?: string | null;
}

export interface ItemMeta {
  turnId?: string;
  /** From the item's first event to its completion (reasoning: "Thought for Ns"). */
  durationMs?: number;
  /** A tool output before history truncation. */
  fullOutput?: string;
}

export type SessionLine =
  | { type: "session_meta"; payload: SessionMeta }
  /** An item appended to history. */
  | { type: "item"; payload: { item: InputItem } & ItemMeta }
  /** The request baseline changed (no configuration_update support). */
  | { type: "baseline"; payload: { effort: ReasoningEffort } }
  /** Safety settings changed mid-thread (F4: thread settings). */
  | { type: "safety"; payload: SafetySummary }
  /** Reference directories changed mid-thread (F4.5). */
  | { type: "context"; payload: { references: string[] } }
  /** A completed tool call with its structured details, for rebuilding the UI. */
  | { type: "tool"; payload: { turnId: string; callId: string; name: string; arguments: string; success: boolean; details?: ToolDetails } }
  /** Context compaction: the history from here on starts over with these items (F4). */
  | { type: "compacted"; payload: { items: InputItem[]; reason: "auto" | "manual"; baseline: ReasoningEffort; turnId?: string } }
  | { type: "turn"; payload: Record<string, unknown> }
  | { type: "usage"; payload: Record<string, unknown> }
  | { type: "approval"; payload: Record<string, unknown> };

export type TimedSessionLine = SessionLine & { timestamp: string };

export interface LoadedSession {
  path: string;
  meta: SessionMeta;
  items: InputItem[];
  baseline: ReasoningEffort;
  /** The latest safety settings recorded (meta, or a later `safety` line). */
  safety: SafetySummary | null;
  /** The latest reference directories recorded (meta, or a later `context` line). */
  references: string[];
  initialItemCount: number;
}

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  model: string;
  createdAt: string;
  /** Last modification of the file (ms since the epoch). */
  updatedAt: number;
  /** The first user message, shortened. */
  title: string;
  /** SessionMeta.projectId: undefined when the session predates projects or came from the CLI. */
  projectId?: string | null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Parses a session file; a partial last line (crash) is ignored, anything else corrupt throws. */
export function parseSessionLines(text: string, path: string): TimedSessionLine[] {
  const raw = text.split("\n");
  const lines: TimedSessionLine[] = [];
  for (const [index, line] of raw.entries()) {
    if (line.trim() === "") continue;
    try {
      lines.push(JSON.parse(line) as TimedSessionLine);
    } catch {
      if (index >= raw.length - 2) break;
      throw new Error(`session file ${path} is corrupt at line ${index + 1}`);
    }
  }
  return lines;
}

function messageText(item: InputItem): string | null {
  if (item.type !== "message" || item.role !== "user") return null;
  return item.content.map((part) => (part.type === "input_image" ? "[image]" : part.text)).join(" ");
}

export class SessionStore {
  readonly path: string;
  private readonly fs: HostFileSystem;
  private chain: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  private constructor(fs: HostFileSystem, path: string) {
    this.fs = fs;
    this.path = path;
  }

  static async create(fs: HostFileSystem, sessionsDir: string, meta: SessionMeta, now: Date): Promise<SessionStore> {
    const day = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
    const directory = `${sessionsDir}/${day}`;
    await fs.mkdir(directory, { mode: SESSION_DIR_MODE });
    const stamp = `${day.replace(/\//g, "-")}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const store = new SessionStore(fs, `${directory}/${stamp}-${meta.id}.jsonl`);
    store.append({ type: "session_meta", payload: meta });
    await store.flush();
    return store;
  }

  static open(fs: HostFileSystem, path: string): SessionStore {
    return new SessionStore(fs, path);
  }

  /** Queues a line; writes happen in order. A failed write is reported by flush(). */
  append(line: SessionLine): void {
    const text = `${JSON.stringify({ timestamp: new Date().toISOString(), ...line })}\n`;
    this.chain = this.chain.then(async () => {
      try {
        await this.fs.appendFile(this.path, text, { mode: SESSION_FILE_MODE });
      } catch (error) {
        this.failure ??= error;
      }
    });
  }

  /** Waits for queued writes; throws the first write failure once. */
  async flush(): Promise<void> {
    await this.chain;
    if (this.failure) {
      const failure = this.failure;
      this.failure = null;
      throw failure;
    }
  }

  /** Every session file, newest directory first. */
  static async files(fs: HostFileSystem, sessionsDir: string): Promise<string[]> {
    if (!(await fs.stat(sessionsDir))) return [];
    const files: string[] = [];
    for (const year of (await fs.readDir(sessionsDir)).reverse()) {
      for (const month of (await fs.readDir(`${sessionsDir}/${year}`)).reverse()) {
        for (const day of (await fs.readDir(`${sessionsDir}/${year}/${month}`)).reverse()) {
          const directory = `${sessionsDir}/${year}/${month}/${day}`;
          for (const name of (await fs.readDir(directory)).reverse()) {
            if (name.endsWith(".jsonl")) files.push(`${directory}/${name}`);
          }
        }
      }
    }
    return files;
  }

  /** Finds a session file by thread id. */
  static async find(fs: HostFileSystem, sessionsDir: string, id: string): Promise<string | null> {
    return (await SessionStore.files(fs, sessionsDir)).find((path) => path.endsWith(`-${id}.jsonl`)) ?? null;
  }

  /**
   * Summaries for a session list, most recently updated first. MVP: reads each file's
   * beginning (DEVELOPMENT_PLAN.md 10.3; a database index may replace this later).
   */
  static async list(fs: HostFileSystem, sessionsDir: string, headBytes = 256 * 1024): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const path of await SessionStore.files(fs, sessionsDir)) {
      const entry = await fs.stat(path);
      if (!entry) continue;
      let meta: SessionMeta | null = null;
      let title = "";
      let inTurn = false;
      const text = await fs.readPrefix(path, headBytes);
      for (const raw of text.split("\n")) {
        let line: TimedSessionLine;
        try {
          line = JSON.parse(raw) as TimedSessionLine;
        } catch {
          continue;
        }
        if (line.type === "session_meta") meta = line.payload;
        if (line.type === "turn") inTurn = true;
        if (inTurn && line.type === "item") {
          const text = messageText(line.payload.item);
          if (text !== null) {
            title = text.replace(/\s+/g, " ").trim().slice(0, 120);
            break;
          }
        }
      }
      if (!meta) continue;
      summaries.push({
        id: meta.id,
        path,
        cwd: meta.cwd,
        model: meta.model,
        createdAt: meta.createdAt,
        updatedAt: entry.mtimeMs,
        title,
        ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
      });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  static async read(fs: HostFileSystem, path: string): Promise<TimedSessionLine[]> {
    return parseSessionLines(await fs.readText(path), path);
  }

  static async load(fs: HostFileSystem, path: string): Promise<LoadedSession> {
    let meta: SessionMeta | null = null;
    let items: InputItem[] = [];
    let baseline: ReasoningEffort | null = null;
    let safety: SafetySummary | null = null;
    let references: string[] = [];
    let initialItemCount: number | null = null;
    for (const line of await SessionStore.read(fs, path)) {
      if (line.type === "session_meta") {
        meta = line.payload;
        safety = meta.safety ?? null;
        references = meta.references ?? [];
      } else if (line.type === "item") {
        items.push(InputItem.parse(line.payload.item));
      } else if (line.type === "turn") {
        initialItemCount ??= items.length;
      } else if (line.type === "baseline") {
        baseline = line.payload.effort;
      } else if (line.type === "safety") {
        safety = line.payload;
      } else if (line.type === "context") {
        references = line.payload.references;
      } else if (line.type === "compacted") {
        items = line.payload.items.map((item) => InputItem.parse(item));
        baseline = line.payload.baseline;
      }
    }
    if (!meta) throw new Error(`session file ${path} has no session_meta line`);
    return { path, meta, items, baseline: baseline ?? meta.effort, safety, references, initialItemCount: meta.initialItemCount ?? initialItemCount ?? items.length };
  }
}
