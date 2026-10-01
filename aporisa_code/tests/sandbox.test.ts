// Escape tests against the real macOS Seatbelt (F3). Deterministic and offline: network is
// checked against a loopback server started here.
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NodeHost, seatbeltPolicy, type ProcessManager, type SandboxSpec } from "../src/host/index.ts";

const host = new NodeHost({ shell: "/bin/zsh" });
let base: string;
let work: string;
let outside: string;
let secret: string;
let processes: ProcessManager;
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_request, response) => response.end("loopback ok")).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "aporisa-sandbox-")));
  work = join(base, "work (1)+[x]");
  outside = join(base, "outside");
  secret = join(base, "secret");
  for (const directory of [work, outside, secret, join(work, ".git")]) await mkdir(directory);
  await writeFile(join(secret, "key"), "TOPSECRET-4821");
  await writeFile(join(work, ".git", "HEAD"), "ref: refs/heads/main\n");
  processes = host.openProcessManager();
});

afterEach(async () => {
  await processes.terminateAll();
  await rm(base, { recursive: true, force: true });
});

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return { writableRoots: [work], protectedNames: [".git", ".agents"], denyPaths: [secret], network: false, ...overrides };
}

async function run(command: string, overrides: Partial<SandboxSpec> = {}, env: Record<string, string> = {}) {
  const session = await processes.start({ command, cwd: work, sandbox: spec(overrides), stripSecrets: true, env, login: false });
  return session.read({ yieldMs: 15_000 });
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

describe("seatbelt sandbox (real)", () => {
  it("writes inside the workspace and reads anywhere else", async () => {
    expect(await run("echo hi > inside.txt && mkdir -p sub/dir && cat inside.txt && head -c 2 /etc/hosts")).toMatchObject({ exitCode: 0, output: "hi\n##" });
    expect(await readFile(join(work, "inside.txt"), "utf8")).toBe("hi\n");
  });

  it("blocks writes outside the workspace, also through a symlink", async () => {
    await symlink(outside, join(work, "escape"));
    const direct = await run(`echo x > '${outside}/a.txt'`);
    const viaLink = await run("echo x > escape/b.txt");
    expect(direct.exitCode).not.toBe(0);
    expect(direct.output).toContain("operation not permitted");
    expect(viaLink.exitCode).not.toBe(0);
    expect(await exists(join(outside, "a.txt"))).toBe(false);
    expect(await exists(join(outside, "b.txt"))).toBe(false);
  });

  it("keeps .git read-only, and the workspace root itself", async () => {
    expect((await run("touch .git/index.lock")).exitCode).not.toBe(0);
    expect((await run("rm -rf .git")).exitCode).not.toBe(0);
    expect((await run("mv .git moved")).exitCode).not.toBe(0);
    expect(await readFile(join(work, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    await rm(join(work, ".git"), { recursive: true });
    expect((await run("mkdir .git")).exitCode).not.toBe(0);
    expect((await run("mkdir .agents")).exitCode).not.toBe(0);
    expect(await run("mkdir .github && echo ok")).toMatchObject({ exitCode: 0 });
    expect((await run(`rm -rf '${work}'`)).exitCode).not.toBe(0);
    expect(await exists(work)).toBe(true);
  });

  it("makes private locations unreadable", async () => {
    const result = await run(`cat '${secret}/key'; ls '${secret}'`);
    expect(result.output).not.toContain("TOPSECRET-4821");
    expect(result.output.toLowerCase()).toContain("operation not permitted");
  });

  it("blocks network, even loopback, unless enabled", async () => {
    const url = `http://127.0.0.1:${port}/`;
    const blocked = await run(`/usr/bin/curl -s -m 5 ${url}`);
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.output).not.toContain("loopback ok");
    expect(await run(`/usr/bin/curl -s -m 5 ${url}`, { network: true })).toMatchObject({ exitCode: 0, output: "loopback ok" });
  });

  it("strips secret variables and keeps the rest", async () => {
    process.env.APORISA_TEST_API_KEY = "k";
    process.env.APORISA_TEST_PLAIN = "p";
    try {
      expect((await run("echo ${APORISA_TEST_API_KEY:-none} ${APORISA_TEST_PLAIN:-none} ${GH_TOKEN:-none}")).output).toBe("none p none\n");
    } finally {
      delete process.env.APORISA_TEST_API_KEY;
      delete process.env.APORISA_TEST_PLAIN;
    }
  });

  it("still ends the whole process group of a sandboxed command", async () => {
    const session = await processes.start({ command: "sleep 30 & echo $!; wait", cwd: work, sandbox: spec(), login: false });
    const child = Number((await session.read({ yieldMs: 500 })).output.trim());
    await session.terminate();
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let tries = 0; tries < 100 && alive(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive()).toBe(false);
  });

  it("escapes regex characters in roots and rejects unsupported paths", () => {
    const { policy, params } = seatbeltPolicy(spec());
    expect(policy).toContain(String.raw`work \(1\)\+\[x\]/(\.git|\.agents)(/.*)?$`);
    expect(params).toEqual([["WRITABLE_ROOT_0", work], ["DENIED_PATH_0", secret]]);
    expect(() => seatbeltPolicy(spec({ writableRoots: ['/bad"path'] }))).toThrow("unsupported character");
    expect(() => seatbeltPolicy(spec({ protectedNames: ["../x"] }))).toThrow("invalid protected name");
  });
});
