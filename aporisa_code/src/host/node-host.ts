// The host on Node: real file system and processes, no sandbox yet (F3 adds one).
import { randomUUID } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fromNodeError, HostError } from "./errors.ts";
import { NodeProcessManager } from "./process.ts";
import type { FileStat, Host, HostFileSystem, HostInfo, ProcessManager, ProcessManagerOptions, ReadOptions, WriteOptions } from "./types.ts";

export interface NodeHostOptions {
  /** Default `~/Library/Application Support/Aporisa Code` (DEVELOPMENT_PLAN.md FD-03). */
  dataDir?: string;
  /** Default `$SHELL` when it is absolute, else /bin/zsh. */
  shell?: string;
  /** Defaults for every process manager this host opens. */
  processes?: ProcessManagerOptions;
}

const DEFAULT_FILE_MODE = 0o644;

function requireAbsolute(path: string): void {
  if (!isAbsolute(path)) throw new HostError("invalid_path", `path must be absolute: ${path}`);
}

function toStat(entry: { isFile(): boolean; isDirectory(): boolean; size: number; mode: number; mtimeMs: number }): FileStat {
  return {
    kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
    size: entry.size,
    mode: entry.mode & 0o7777,
    mtimeMs: entry.mtimeMs,
  };
}

class NodeFileSystem implements HostFileSystem {
  async readFile(path: string, options: ReadOptions = {}): Promise<Uint8Array> {
    requireAbsolute(path);
    const entry = await this.stat(path);
    if (!entry) throw new HostError("not_found", `no such file: ${path}`);
    if (entry.kind === "directory") throw new HostError("is_directory", `is a directory: ${path}`);
    if (options.maxBytes !== undefined && entry.size > options.maxBytes) {
      throw new HostError("too_large", `file is larger than ${options.maxBytes} bytes: ${path}`);
    }
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      throw fromNodeError(error, "read", path);
    }
  }

  async readText(path: string, options: ReadOptions = {}): Promise<string> {
    return new TextDecoder("utf-8").decode(await this.readFile(path, options));
  }

  async writeFile(path: string, data: string | Uint8Array, options: WriteOptions = {}): Promise<void> {
    requireAbsolute(path);
    const existing = await this.stat(path);
    if (existing?.kind === "directory") throw new HostError("is_directory", `is a directory: ${path}`);
    // Write through a symlink to its target instead of replacing the link.
    const target = existing ? await this.realpath(path) : path;
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, data, { mode: options.mode ?? DEFAULT_FILE_MODE, flag: "wx" });
      if (existing) await chmod(temporary, existing.mode);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw fromNodeError(error, "write", path);
    }
  }

  async appendFile(path: string, data: string | Uint8Array, options: WriteOptions = {}): Promise<void> {
    requireAbsolute(path);
    try {
      await appendFile(path, data, { mode: options.mode ?? DEFAULT_FILE_MODE });
    } catch (error) {
      throw fromNodeError(error, "append", path);
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    requireAbsolute(path);
    try {
      return toStat(await stat(path));
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return null;
      throw fromNodeError(error, "stat", path);
    }
  }

  async mkdir(path: string, options: { mode?: number } = {}): Promise<void> {
    requireAbsolute(path);
    try {
      await mkdir(path, { recursive: true, ...(options.mode !== undefined ? { mode: options.mode } : {}) });
    } catch (error) {
      throw fromNodeError(error, "mkdir", path);
    }
  }

  async removeFile(path: string): Promise<void> {
    requireAbsolute(path);
    try {
      if ((await lstat(path)).isDirectory()) throw new HostError("is_directory", `is a directory: ${path}`);
      await unlink(path);
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw fromNodeError(error, "remove", path);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    requireAbsolute(from);
    requireAbsolute(to);
    try {
      await rename(from, to);
    } catch (error) {
      throw fromNodeError(error, "rename", from);
    }
  }

  async readDir(path: string): Promise<string[]> {
    requireAbsolute(path);
    try {
      return (await readdir(path)).sort();
    } catch (error) {
      throw fromNodeError(error, "readdir", path);
    }
  }

  async realpath(path: string): Promise<string> {
    requireAbsolute(path);
    try {
      return await realpath(path);
    } catch (error) {
      throw fromNodeError(error, "realpath", path);
    }
  }
}

export class NodeHost implements Host {
  readonly fs: HostFileSystem = new NodeFileSystem();
  private readonly options: NodeHostOptions;

  constructor(options: NodeHostOptions = {}) {
    if (options.dataDir !== undefined) requireAbsolute(options.dataDir);
    if (options.shell !== undefined) requireAbsolute(options.shell);
    this.options = options;
  }

  info(): HostInfo {
    const home = homedir();
    const envShell = process.env.SHELL;
    return {
      platform: process.platform,
      shell: this.options.shell ?? (envShell && isAbsolute(envShell) ? envShell : "/bin/zsh"),
      homeDir: home,
      dataDir: this.options.dataDir ?? join(home, "Library", "Application Support", "Aporisa Code"),
      tmpDir: process.env.TMPDIR ?? tmpdir(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  openProcessManager(options: ProcessManagerOptions = {}): ProcessManager {
    return new NodeProcessManager(this.info().shell, { ...this.options.processes, ...options });
  }
}
