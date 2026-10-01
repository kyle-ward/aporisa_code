// Session record ("rollout", after codex's rollout/): one JSONL file per thread under
// <dataDir>/sessions/YYYY/MM/DD/, directories 0700 and files 0600 (DEVELOPMENT_PLAN.md
// 6.5). It holds full content because resuming needs it; it is user data, not a log.
import type { HostFileSystem } from "../host/index.ts";
import { InputItem, type ReasoningEffort } from "../protocol/index.ts";

export const SESSION_FILE_MODE = 0o600;
export const SESSION_DIR_MODE = 0o700;
export const HARNESS_VERSION = "f2";

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
  safety?: { sandbox: string; approval: string; network: boolean };
}

export type SessionLine =
  | { type: "session_meta"; payload: SessionMeta }
  /** An item appended to history; `fullOutput` keeps a tool output before truncation. */
  | { type: "item"; payload: { item: InputItem; fullOutput?: string } }
  /** The request baseline changed (no configuration_update support). */
  | { type: "baseline"; payload: { effort: ReasoningEffort } }
  | { type: "turn"; payload: Record<string, unknown> }
  | { type: "usage"; payload: Record<string, unknown> }
  | { type: "approval"; payload: Record<string, unknown> };

export interface LoadedSession {
  path: string;
  meta: SessionMeta;
  items: InputItem[];
  baseline: ReasoningEffort;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
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

  static async create(fs: HostFileSystem, dataDir: string, meta: SessionMeta, now: Date): Promise<SessionStore> {
    const day = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
    const directory = `${dataDir}/sessions/${day}`;
    await fs.mkdir(dataDir, { mode: SESSION_DIR_MODE });
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

  /** Finds a session file by thread id. */
  static async find(fs: HostFileSystem, dataDir: string, id: string): Promise<string | null> {
    const root = `${dataDir}/sessions`;
    if (!(await fs.stat(root))) return null;
    for (const year of (await fs.readDir(root)).reverse()) {
      for (const month of (await fs.readDir(`${root}/${year}`)).reverse()) {
        for (const day of (await fs.readDir(`${root}/${year}/${month}`)).reverse()) {
          const name = (await fs.readDir(`${root}/${year}/${month}/${day}`)).find((entry) => entry.endsWith(`-${id}.jsonl`));
          if (name) return `${root}/${year}/${month}/${day}/${name}`;
        }
      }
    }
    return null;
  }

  static async load(fs: HostFileSystem, path: string): Promise<LoadedSession> {
    const text = await fs.readText(path);
    let meta: SessionMeta | null = null;
    const items: InputItem[] = [];
    let baseline: ReasoningEffort | null = null;
    const lines = text.split("\n");
    for (const [index, raw] of lines.entries()) {
      if (raw.trim() === "") continue;
      let line: SessionLine;
      try {
        line = JSON.parse(raw) as SessionLine;
      } catch {
        // A crash can leave a partial last line; anything earlier is corruption.
        if (index >= lines.length - 2) break;
        throw new Error(`session file ${path} is corrupt at line ${index + 1}`);
      }
      if (line.type === "session_meta") meta = line.payload;
      else if (line.type === "item") items.push(InputItem.parse(line.payload.item));
      else if (line.type === "baseline") baseline = line.payload.effort;
    }
    if (!meta) throw new Error(`session file ${path} has no session_meta line`);
    return { path, meta, items, baseline: baseline ?? meta.effort };
  }
}
