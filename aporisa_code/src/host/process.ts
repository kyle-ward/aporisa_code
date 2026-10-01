// Process sessions on Node (codex's unified exec without a PTY; DEVELOPMENT_PLAN.md 4.2).
// Each command gets its own process group; only groups this manager created are signalled.
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { constants } from "node:os";
import { isAbsolute } from "node:path";
import { HostError } from "./errors.ts";
import { HeadTailBuffer } from "./head-tail-buffer.ts";
import type {
  ExecRequest,
  ProcessChunk,
  ProcessManager,
  ProcessManagerOptions,
  ProcessReadOptions,
  ProcessSession,
} from "./types.ts";

/** Non-interactive defaults on top of the user's environment (codex process_manager.rs). */
export const EXEC_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  TERM: "dumb",
  LANG: "C.UTF-8",
  LC_CTYPE: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
};

export const PROCESS_DEFAULTS: Required<ProcessManagerOptions> = {
  maxSessions: 64,
  idleTimeoutMs: 300_000,
  outputMaxBytes: 1024 * 1024,
  killGraceMs: 2_000,
};

/** After the main process exits, how long its pipes may stay open before the group is killed. */
const TRAILING_OUTPUT_GRACE_MS = 100;
/** terminate() stops waiting this long after SIGKILL (a process stuck in the kernel). */
const KILL_WAIT_MS = 5_000;
const INTERRUPT = "\u0003";
const END_OF_INPUT = "\u0004";

/** Marker between head and tail when an interval's output exceeded the buffer (codex wording). */
export function omissionMarker(omittedBytes: number): string {
  return `... ${omittedBytes} bytes omitted ...`;
}

export class NodeProcessManager implements ProcessManager {
  private readonly options: Required<ProcessManagerOptions>;
  private readonly defaultShell: string;
  private readonly sessions = new Map<number, NodeProcessSession>();
  private nextId = 1;

  constructor(defaultShell: string, options: ProcessManagerOptions = {}) {
    this.defaultShell = defaultShell;
    this.options = { ...PROCESS_DEFAULTS, ...options };
  }

  get size(): number {
    return this.sessions.size;
  }

  get(id: number): ProcessSession | undefined {
    return this.sessions.get(id);
  }

  async start(request: ExecRequest): Promise<ProcessSession> {
    const shell = request.shell ?? this.defaultShell;
    if (!isAbsolute(request.cwd)) throw new HostError("invalid_path", `working directory must be absolute: ${request.cwd}`);
    if (!isAbsolute(shell)) throw new HostError("invalid_path", `shell must be an absolute path: ${shell}`);
    if (this.sessions.size >= this.options.maxSessions) {
      throw new HostError("limit_exceeded", `too many running processes (at most ${this.options.maxSessions}); finish or stop one first`);
    }
    const cwdStat = await stat(request.cwd).catch(() => null);
    if (!cwdStat) throw new HostError("not_found", `working directory does not exist: ${request.cwd}`);
    if (!cwdStat.isDirectory()) throw new HostError("not_a_directory", `working directory is not a directory: ${request.cwd}`);

    const child = spawn(shell, [request.login === false ? "-c" : "-lc", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...EXEC_ENV, ...request.env },
      detached: true, // setsid: the shell leads a new process group
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => {
        const missing = (error as { code?: unknown }).code === "ENOENT";
        reject(new HostError(missing ? "not_found" : "io_error", `could not start ${shell}: ${missing ? "not found" : "spawn failed"}`, { cause: error }));
      });
    });

    const id = this.nextId;
    this.nextId += 1;
    const session = new NodeProcessSession(id, child, this.options, () => this.sessions.delete(id));
    this.sessions.set(id, session);
    return session;
  }

  async terminateAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.terminate()));
  }
}

class NodeProcessSession implements ProcessSession {
  readonly id: number;
  private readonly child: ChildProcess;
  private readonly pgid: number;
  private readonly options: Required<ProcessManagerOptions>;
  private readonly onClose: () => void;
  private readonly buffer: HeadTailBuffer;
  private exitCode: number | null = null;
  private finished = false;
  private closed = false;
  private reading = false;
  private stdinOpen = true;
  private graceTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly finishWaiters = new Set<() => void>();

  constructor(id: number, child: ChildProcess, options: Required<ProcessManagerOptions>, onClose: () => void) {
    this.id = id;
    this.child = child;
    this.pgid = child.pid ?? 0;
    this.options = options;
    this.onClose = onClose;
    this.buffer = new HeadTailBuffer(options.outputMaxBytes);

    const collect = (chunk: Buffer) => this.buffer.push(chunk);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    // Late errors (e.g. a failed kill) must not become uncaught exceptions.
    child.on("error", () => undefined);
    child.stdin?.on("error", () => {
      // EPIPE after the process stopped reading; write() reports a closed stdin instead.
      this.stdinOpen = false;
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0);
      // Leftover group members may hold the pipes open; give trailing output a moment.
      this.graceTimer = setTimeout(() => this.signalGroup("SIGKILL"), TRAILING_OUTPUT_GRACE_MS);
    });
    child.on("close", () => {
      if (this.graceTimer) clearTimeout(this.graceTimer);
      // Whatever is left of the group (background jobs without our pipes) goes too.
      this.signalGroup("SIGKILL");
      this.finished = true;
      this.stdinOpen = false;
      for (const wake of this.finishWaiters) wake();
      this.finishWaiters.clear();
    });
    this.armIdleTimer();
  }

  get running(): boolean {
    return !this.finished;
  }

  async read(options: ProcessReadOptions): Promise<ProcessChunk> {
    if (this.closed) throw new HostError("process_exited", `process ${this.id} has already exited and was reported`);
    if (this.reading) throw new HostError("busy", `process ${this.id} is already being read`);
    this.reading = true;
    this.disarmIdleTimer();
    const started = performance.now();
    try {
      await this.waitFinished(Math.max(0, options.yieldMs), options.signal);
      const snapshot = this.buffer.take();
      // Lossy decoding, like codex: a character split at a read boundary becomes U+FFFD.
      const head = new TextDecoder("utf-8").decode(snapshot.head);
      const tail = new TextDecoder("utf-8").decode(snapshot.tail);
      const output = snapshot.omittedBytes > 0 ? `${head}\n${omissionMarker(snapshot.omittedBytes)}\n${tail}` : head + tail;
      const chunk: ProcessChunk = {
        output,
        totalBytes: snapshot.totalBytes,
        omittedBytes: snapshot.omittedBytes,
        exitCode: this.finished ? this.exitCode : null,
        wallTimeMs: performance.now() - started,
      };
      if (this.finished) this.close();
      return chunk;
    } finally {
      this.reading = false;
      if (!this.closed) this.armIdleTimer();
    }
  }

  async write(chars: string): Promise<void> {
    if (this.finished) throw new HostError("process_exited", `process ${this.id} has exited`);
    let pending = "";
    for (const char of chars) {
      if (char === INTERRUPT) {
        await this.writeStdin(pending);
        pending = "";
        this.signalGroup("SIGINT");
      } else if (char === END_OF_INPUT) {
        await this.writeStdin(pending);
        pending = "";
        if (this.stdinOpen) {
          this.stdinOpen = false;
          this.child.stdin?.end();
        }
      } else {
        pending += char;
      }
    }
    await this.writeStdin(pending);
  }

  async terminate(): Promise<void> {
    if (!this.finished) {
      this.signalGroup("SIGTERM");
      if (!(await this.waitFinished(this.options.killGraceMs))) {
        this.signalGroup("SIGKILL");
        await this.waitFinished(KILL_WAIT_MS);
      }
    }
    this.close();
  }

  private async writeStdin(text: string): Promise<void> {
    if (text.length === 0) return;
    const stdin = this.child.stdin;
    if (!this.stdinOpen || !stdin || stdin.writableEnded) {
      throw new HostError("io_error", `stdin of process ${this.id} is closed`);
    }
    await new Promise<void>((resolve, reject) => {
      stdin.write(text, (error) => {
        if (error) reject(new HostError("io_error", `writing to process ${this.id} failed`, { cause: error }));
        else resolve();
      });
    });
  }

  /** Resolves true once finished, false when the timeout or the signal comes first. */
  private waitFinished(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.finished) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.finishWaiters.delete(onFinish);
        resolve(value);
      };
      const onFinish = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.finishWaiters.add(onFinish);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private signalGroup(signal: NodeJS.Signals): void {
    if (this.pgid <= 0) return;
    try {
      process.kill(-this.pgid, signal);
    } catch {
      // ESRCH: the group is already gone.
    }
  }

  private armIdleTimer(): void {
    this.disarmIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.reading) void this.terminate();
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disarmIdleTimer();
    this.onClose();
  }
}
