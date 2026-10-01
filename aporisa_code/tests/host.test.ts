import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeadTailBuffer, HostError, NodeHost, omissionMarker, type ProcessManager } from "../src/host/index.ts";

const SH = "/bin/sh";
let root: string;
const managers: ProcessManager[] = [];

function open(host: NodeHost, options: Parameters<NodeHost["openProcessManager"]>[0] = {}): ProcessManager {
  const manager = host.openProcessManager(options);
  managers.push(manager);
  return manager;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aporisa-host-"));
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.terminateAll()));
  await rm(root, { recursive: true, force: true });
});

describe("head-tail buffer", () => {
  it("keeps the first and last bytes and counts the middle", () => {
    const buffer = new HeadTailBuffer(8);
    buffer.push(new TextEncoder().encode("abcdef"));
    buffer.push(new TextEncoder().encode("ghijkl"));
    const snapshot = buffer.take();
    expect(new TextDecoder().decode(snapshot.head)).toBe("abcd");
    expect(new TextDecoder().decode(snapshot.tail)).toBe("ijkl");
    expect(snapshot).toMatchObject({ totalBytes: 12, omittedBytes: 4 });
    expect(buffer.take()).toMatchObject({ totalBytes: 0, omittedBytes: 0 });
  });
});

describe("host file system", () => {
  const host = new NodeHost({ shell: SH });

  it("writes atomically, keeps an existing mode and leaves no temporary files", async () => {
    const path = join(root, "script.sh");
    await host.fs.writeFile(path, "echo one\n", { mode: 0o755 });
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    await host.fs.writeFile(path, "echo two\n");
    expect(await readFile(path, "utf8")).toBe("echo two\n");
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect(await readdir(root)).toEqual(["script.sh"]);
  });

  it("creates private files with an explicit mode and appends", async () => {
    const path = join(root, "sessions", "a.jsonl");
    await host.fs.mkdir(join(root, "sessions"), { mode: 0o700 });
    await host.fs.appendFile(path, "1\n", { mode: 0o600 });
    await host.fs.appendFile(path, "2\n", { mode: 0o600 });
    expect(await readFile(path, "utf8")).toBe("1\n2\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "sessions"))).mode & 0o777).toBe(0o700);
  });

  it("writes through a symlink instead of replacing it", async () => {
    const target = join(root, "real.txt");
    await writeFile(target, "old");
    await symlink(target, join(root, "link.txt"));
    await host.fs.writeFile(join(root, "link.txt"), "new");
    expect(await readFile(target, "utf8")).toBe("new");
    expect((await host.fs.stat(join(root, "link.txt")))?.kind).toBe("file");
  });

  it("reports missing paths, size limits, directories and relative paths explicitly", async () => {
    await writeFile(join(root, "big.bin"), new Uint8Array(100));
    expect(await host.fs.stat(join(root, "missing"))).toBeNull();
    await expect(host.fs.readFile(join(root, "missing"))).rejects.toMatchObject({ code: "not_found" });
    await expect(host.fs.readFile(join(root, "big.bin"), { maxBytes: 10 })).rejects.toMatchObject({ code: "too_large" });
    await expect(host.fs.readFile(root)).rejects.toMatchObject({ code: "is_directory" });
    await expect(host.fs.removeFile(root)).rejects.toMatchObject({ code: "is_directory" });
    await expect(host.fs.readText("relative.txt")).rejects.toMatchObject({ code: "invalid_path" });
    expect((await host.fs.readFile(join(root, "big.bin"), { maxBytes: 100 })).byteLength).toBe(100);
  });

  it("removes and renames files and lists directories", async () => {
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "0.txt"), "0");
    expect(await host.fs.readDir(root)).toEqual(["0.txt", "a.txt"]);
    await host.fs.removeFile(join(root, "0.txt"));
    await host.fs.rename(join(root, "a.txt"), join(root, "b.txt"));
    expect(await host.fs.readText(join(root, "b.txt"))).toBe("a");
    await host.fs.removeFile(join(root, "b.txt"));
    expect(await readdir(root)).toEqual([]);
  });

  it("describes the environment", () => {
    const info = new NodeHost({ dataDir: "/tmp/aporisa-data" }).info();
    expect(info.dataDir).toBe("/tmp/aporisa-data");
    expect(info.shell.startsWith("/")).toBe(true);
    expect(info.timeZone.length).toBeGreaterThan(0);
    expect(new NodeHost().info().dataDir).toMatch(/Library\/Application Support\/Aporisa Code$/);
  });
});

describe("host processes", () => {
  const host = new NodeHost({ shell: SH });

  it("runs a command in the working directory with the non-interactive environment", async () => {
    const manager = open(host);
    const session = await manager.start({ command: 'pwd; echo "$PAGER $NO_COLOR"; echo oops >&2; exit 3', cwd: root, login: false });
    const chunk = await session.read({ yieldMs: 5_000 });
    expect(chunk.exitCode).toBe(3);
    expect(chunk.output).toContain(await host.fs.realpath(root));
    expect(chunk.output).toContain("cat 1");
    expect(chunk.output).toContain("oops");
    expect(chunk.wallTimeMs).toBeLessThan(5_000);
    expect(manager.size).toBe(0);
    await expect(session.read({ yieldMs: 0 })).rejects.toMatchObject({ code: "process_exited" });
  });

  it("yields while running and continues through stdin", async () => {
    const manager = open(host);
    const session = await manager.start({ command: "echo ready; read line; echo got:$line", cwd: root, login: false });
    const first = await session.read({ yieldMs: 300 });
    expect(first).toMatchObject({ exitCode: null, output: "ready\n" });
    expect(session.running).toBe(true);
    expect(manager.get(session.id)).toBe(session);
    await session.write("hello\n");
    const second = await session.read({ yieldMs: 5_000 });
    expect(second).toMatchObject({ exitCode: 0, output: "got:hello\n" });
  });

  it("treats Ctrl-D as end of input and Ctrl-C as an interrupt", async () => {
    const manager = open(host);
    const cat = await manager.start({ command: "cat", cwd: root, login: false });
    await cat.write("abc\u0004");
    expect(await cat.read({ yieldMs: 5_000 })).toMatchObject({ exitCode: 0, output: "abc" });
    await expect(cat.write("x")).rejects.toBeInstanceOf(HostError);

    const sleeper = await manager.start({ command: "sleep 30", cwd: root, login: false });
    await sleeper.write("\u0003");
    expect((await sleeper.read({ yieldMs: 5_000 })).exitCode).toBe(130);
  });

  it("terminates the whole process group, children included", async () => {
    const manager = open(host);
    const session = await manager.start({ command: "sleep 30 & echo $!; wait", cwd: root, login: false });
    const childPid = Number((await session.read({ yieldMs: 300 })).output.trim());
    expect(alive(childPid)).toBe(true);
    await session.terminate();
    expect(await eventually(() => !alive(childPid))).toBe(true);
    expect(manager.size).toBe(0);
  });

  it("kills what is left of the group when the main process exits", async () => {
    const manager = open(host);
    const session = await manager.start({ command: "sleep 30 >/dev/null 2>&1 & echo $!", cwd: root, login: false });
    const chunk = await session.read({ yieldMs: 5_000 });
    expect(chunk.exitCode).toBe(0);
    expect(await eventually(() => !alive(Number(chunk.output.trim())))).toBe(true);
  });

  it("finishes even when a background job holds the pipes open", async () => {
    const manager = open(host);
    const session = await manager.start({ command: "sleep 30 & echo started", cwd: root, login: false });
    const chunk = await session.read({ yieldMs: 5_000 });
    expect(chunk).toMatchObject({ exitCode: 0, output: "started\n" });
    expect(chunk.wallTimeMs).toBeLessThan(2_000);
  });

  it("keeps the head and tail of large output", async () => {
    const manager = open(host, { outputMaxBytes: 1_000 });
    const session = await manager.start({ command: "printf 'A%.0s' $(seq 1 600); printf 'B%.0s' $(seq 1 600)", cwd: root, login: false });
    const chunk = await session.read({ yieldMs: 5_000 });
    expect(chunk.totalBytes).toBe(1_200);
    expect(chunk.omittedBytes).toBe(200);
    expect(chunk.output).toBe(`${"A".repeat(500)}\n${omissionMarker(200)}\n${"B".repeat(500)}`);
  });

  it("bounds the number of sessions and frees a slot when one ends", async () => {
    const manager = open(host, { maxSessions: 2 });
    const first = await manager.start({ command: "sleep 30", cwd: root, login: false });
    await manager.start({ command: "sleep 30", cwd: root, login: false });
    await expect(manager.start({ command: "true", cwd: root, login: false })).rejects.toMatchObject({ code: "limit_exceeded" });
    await first.terminate();
    await expect(manager.start({ command: "true", cwd: root, login: false })).resolves.toBeDefined();
  });

  it("drops sessions nobody reads within the idle timeout", async () => {
    const manager = open(host, { idleTimeoutMs: 200 });
    await manager.start({ command: "sleep 30", cwd: root, login: false });
    expect(await eventually(() => manager.size === 0)).toBe(true);
  });

  it("returns early when the read is aborted and allows only one reader", async () => {
    const manager = open(host);
    const session = await manager.start({ command: "sleep 30", cwd: root, login: false });
    const controller = new AbortController();
    const pending = session.read({ yieldMs: 10_000, signal: controller.signal });
    await expect(session.read({ yieldMs: 0 })).rejects.toMatchObject({ code: "busy" });
    controller.abort();
    expect((await pending).exitCode).toBeNull();
    expect(session.running).toBe(true);
  });

  it("terminates everything at once and reports start failures", async () => {
    const manager = open(host);
    await manager.start({ command: "sleep 30", cwd: root, login: false });
    await manager.start({ command: "sleep 30", cwd: root, login: false });
    await manager.terminateAll();
    expect(manager.size).toBe(0);
    await expect(manager.start({ command: "true", cwd: join(root, "missing") })).rejects.toMatchObject({ code: "not_found" });
    await expect(manager.start({ command: "true", cwd: "relative" })).rejects.toMatchObject({ code: "invalid_path" });
    await expect(manager.start({ command: "true", cwd: root, shell: "/no/such/shell" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("runs commands through a login shell by default", async () => {
    const manager = open(host);
    const session = await manager.start({ command: "ps -o args= -p $$; true", cwd: root });
    const chunk = await session.read({ yieldMs: 10_000 });
    expect(chunk.exitCode).toBe(0);
    expect(chunk.output).toContain(`${SH} -lc ps -o args= -p $$; true`);
  });
});
