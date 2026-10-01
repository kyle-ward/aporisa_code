// The host interface: the only way the harness touches the file system and processes
// (AGENTS.md; DEVELOPMENT_PLAN.md section 4). F3 adds sandboxing at this layer.

export type FileKind = "file" | "directory" | "other";

export interface FileStat {
  kind: FileKind;
  size: number;
  /** Permission bits (mode & 0o7777). */
  mode: number;
  mtimeMs: number;
}

export interface ReadOptions {
  /** Refuse files larger than this (HostError "too_large") instead of reading them. */
  maxBytes?: number;
}

export interface WriteOptions {
  /** Mode for a new file; an existing file keeps its mode. Default 0o644 (before umask). */
  mode?: number;
}

/** All paths are absolute; relative paths are rejected with HostError "invalid_path". */
export interface HostFileSystem {
  readFile(path: string, options?: ReadOptions): Promise<Uint8Array>;
  readText(path: string, options?: ReadOptions): Promise<string>;
  /** Atomic: writes a temporary file in the same directory, then renames it into place. */
  writeFile(path: string, data: string | Uint8Array, options?: WriteOptions): Promise<void>;
  /** Appends, creating the file with `mode` when it does not exist. */
  appendFile(path: string, data: string | Uint8Array, options?: WriteOptions): Promise<void>;
  /** Null when nothing exists at the path. Does not follow a final symlink's absence. */
  stat(path: string): Promise<FileStat | null>;
  /** Recursive; succeeds when the directory already exists. */
  mkdir(path: string, options?: { mode?: number }): Promise<void>;
  /** Removes a file (not a directory). */
  removeFile(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  realpath(path: string): Promise<string>;
  /** Entry names of a directory, sorted. */
  readDir(path: string): Promise<string[]>;
}

/** What a sandboxed command may do (F3). Every path must be absolute and already resolved
 * (realpath): Seatbelt matches physical paths, so /tmp must be given as /private/tmp. */
export interface SandboxSpec {
  /** Directories the command may write below (reads are unrestricted except denyPaths). */
  writableRoots: string[];
  /** Entries directly under each writable root that stay read-only, e.g. ".git". */
  protectedNames: string[];
  /** Neither readable nor writable, overriding everything else. */
  denyPaths: string[];
  /** Outbound and inbound network, including loopback. */
  network: boolean;
}

export interface ExecRequest {
  /** Shell command line, run as `<shell> -lc <command>` (or `-c` when login is false). */
  command: string;
  /** Absolute working directory; it must exist. */
  cwd: string;
  /** Extra variables on top of the inherited environment and the non-interactive defaults. */
  env?: Record<string, string>;
  /** Absolute path of the shell; defaults to the host's shell. */
  shell?: string;
  /** Run as a login shell (codex default). Default true. */
  login?: boolean;
  /** Run under the macOS Seatbelt sandbox; absent runs unsandboxed. */
  sandbox?: SandboxSpec;
  /** Drop inherited variables whose names contain KEY, SECRET or TOKEN (codex's default excludes). */
  stripSecrets?: boolean;
}

export interface ProcessChunk {
  /**
   * Output (stdout and stderr interleaved) produced since the previous read, decoded as
   * UTF-8. When the interval overflowed the buffer, head and tail are joined by a line
   * `... N bytes omitted ...`.
   */
  output: string;
  /** Bytes produced since the previous read, including any omitted ones. */
  totalBytes: number;
  /** Bytes dropped from the middle because the interval exceeded the output buffer. */
  omittedBytes: number;
  /** Exit code once the process has finished (128 + signal number when killed by a signal). */
  exitCode: number | null;
  /** Milliseconds this read spent waiting. */
  wallTimeMs: number;
}

export interface ProcessReadOptions {
  /** Return after this long even if the process is still running. */
  yieldMs: number;
  /** Stop waiting early (the process keeps running). */
  signal?: AbortSignal;
}

/**
 * One running command (codex's unified exec process, without a PTY: stdin, stdout and
 * stderr are pipes). The command runs in its own process group; when its main process
 * exits, whatever is left in that group is killed.
 */
export interface ProcessSession {
  readonly id: number;
  /** True until the main process has exited and its output has been drained. */
  readonly running: boolean;
  /**
   * Waits until the process finishes or `yieldMs` passes, then returns the output since
   * the previous read. Once a read has reported the exit code, the session is closed and
   * removed from its manager. Only one read may be pending at a time ("busy").
   */
  read(options: ProcessReadOptions): Promise<ProcessChunk>;
  /**
   * Writes to stdin. Control characters act like a terminal's: U+0003 (Ctrl-C) sends
   * SIGINT to the process group, U+0004 (Ctrl-D) closes stdin.
   */
  write(chars: string): Promise<void>;
  /** SIGTERM to the process group, SIGKILL after a grace period; resolves once it is gone. */
  terminate(): Promise<void>;
}

export interface ProcessManagerOptions {
  /** Most sessions alive at once (running, or finished but not yet read). Default 64. */
  maxSessions?: number;
  /** A session nobody has read for this long is terminated and dropped. Default 300 s. */
  idleTimeoutMs?: number;
  /** Output kept per read interval, half head and half tail. Default 1 MiB. */
  outputMaxBytes?: number;
  /** SIGTERM-to-SIGKILL grace in terminate(). Default 2 s. */
  killGraceMs?: number;
}

/** Owns a set of sessions; the harness opens one per thread so ids never cross threads. */
export interface ProcessManager {
  start(request: ExecRequest): Promise<ProcessSession>;
  get(id: number): ProcessSession | undefined;
  readonly size: number;
  /** Terminates every session (turn cancelled, thread closed, app quitting). */
  terminateAll(): Promise<void>;
}

export interface HostInfo {
  platform: string;
  /** Absolute path of the user's shell. */
  shell: string;
  homeDir: string;
  /** Where sessions and other app data live (0700). */
  dataDir: string;
  /** The per-user temporary directory ($TMPDIR), as given (not resolved). */
  tmpDir: string;
  /** IANA time zone, e.g. "Asia/Hong_Kong". */
  timeZone: string;
}

export interface Host {
  readonly fs: HostFileSystem;
  info(): HostInfo;
  openProcessManager(options?: ProcessManagerOptions): ProcessManager;
}
