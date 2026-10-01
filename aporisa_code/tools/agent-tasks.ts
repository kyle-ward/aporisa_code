// F2 real-task acceptance (DEVELOPMENT_PLAN.md 7.2). Networked and user-run against the
// real backend; never part of scripts/check.sh. Each task gets a fresh git repository in
// a temporary directory and runs with every command and patch allowed (no sandbox in F2:
// the model's commands run as the user, inside that directory by instruction only).
//
//   npm run agent-tasks                       all tasks against APORISA_BASE_URL (.env)
//   npm run agent-tasks -- --only fix-test    one task (repeatable)
//   npm run agent-tasks -- --driver stub      plumbing check without a backend (tasks fail)
//
// The report (metrics only, no prompts or model output) goes to stdout and to
// ../.runtime/agent-tasks/<timestamp>.json; session records keep the full trajectories.
// A stub run writes neither: it only exercises this script.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";
import { loadEnv } from "../src/cli/env.ts";
import { Thread, type ThreadEvent, type TurnOutcome } from "../src/harness/index.ts";
import { NodeHost } from "../src/host/index.ts";
import { StubDriver } from "../src/mock/index.ts";
import type { Usage } from "../src/protocol/index.ts";
import { NativeDriver, type AporisaClient } from "../src/sdk/index.ts";

interface Task {
  id: string;
  title: string;
  files: Record<string, string | Uint8Array>;
  prompt: string;
  /** Null when the task passed, otherwise why it did not. */
  check: (dir: string, outcome: TurnOutcome, events: readonly ThreadEvent[]) => string | null;
}

const TASK_TIMEOUT_MS = 15 * 60_000;
const MAX_REQUESTS = 80;

function run(dir: string, command: string, args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync(command, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }) };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function read(dir: string, path: string): string {
  try {
    return readFileSync(join(dir, path), "utf8");
  } catch {
    return "";
  }
}

const unittest = (dir: string): string | null => (run(dir, "python3", ["-m", "unittest", "-q"]).ok ? null : "python3 -m unittest fails");

// --- a small PNG: a red disc on white, for view_image ---------------------------------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.byteLength, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

export function redDiscPng(size = 256): Buffer {
  const rows: Buffer[] = [];
  const center = size / 2;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3, 255);
    row[0] = 0;
    for (let x = 0; x < size; x += 1) {
      if ((x - center) ** 2 + (y - center) ** 2 <= (size * 0.35) ** 2) {
        row[1 + x * 3] = 220;
        row[2 + x * 3] = 20;
        row[3 + x * 3] = 30;
      }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolor RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", new Uint8Array())]);
}

// --- tasks -------------------------------------------------------------------------------

const numbers = Array.from({ length: 20 }, (_, index) => (index * 37 + 11) % 97);

export const TASKS: Task[] = [
  {
    id: "fix-test",
    title: "fix a failing unit test",
    files: {
      "calc.py": "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n",
      "test_calc.py": "import unittest\n\nfrom calc import add, mul\n\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n    def test_mul(self):\n        self.assertEqual(mul(2, 3), 6)\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
    },
    prompt: "The unit tests in this repository fail. Find and fix the bug without changing the tests, then run the tests to confirm (python3 -m unittest).",
    check: (dir) => unittest(dir) ?? (read(dir, "test_calc.py").includes("assertEqual(add(2, 3), 5)") ? null : "the test was changed"),
  },
  {
    id: "add-function",
    title: "add a function with tests",
    files: {
      "text_utils.py": 'def slugify(text):\n    """Lowercase words joined by dashes."""\n    return "-".join(text.lower().split())\n',
      "test_text_utils.py": "import unittest\n\nfrom text_utils import slugify\n\n\nclass SlugifyTest(unittest.TestCase):\n    def test_slugify(self):\n        self.assertEqual(slugify('Hello World'), 'hello-world')\n",
    },
    prompt: "Add a function count_vowels(text) to text_utils.py that returns how many vowels (a, e, i, o, u, case-insensitive) the text contains, and add unit tests for it to test_text_utils.py. Run the tests.",
    check: (dir) => {
      const probe = run(dir, "python3", ["-c", "from text_utils import count_vowels as c; assert c('Hello World') == 3 and c('AEIOUxyz') == 5 and c('') == 0"]);
      if (!probe.ok) return "count_vowels is missing or wrong";
      if (!read(dir, "test_text_utils.py").includes("count_vowels")) return "no tests for count_vowels";
      return unittest(dir);
    },
  },
  {
    id: "edit-config",
    title: "edit a JSON config",
    files: { "config.json": `${JSON.stringify({ name: "demo", port: 8080, debug: true, features: ["auth", "billing"] }, null, 2)}\n` },
    prompt: "In config.json, set port to 9090, turn debug off, and add \"search\" to features. Keep everything else unchanged and keep the file valid JSON.",
    check: (dir) => {
      try {
        const config = JSON.parse(read(dir, "config.json"));
        const ok = config.name === "demo" && config.port === 9090 && config.debug === false && JSON.stringify(config.features) === JSON.stringify(["auth", "billing", "search"]);
        return ok ? null : "config.json does not have the requested values";
      } catch {
        return "config.json is not valid JSON";
      }
    },
  },
  {
    id: "rename",
    title: "rename a function across files",
    files: {
      "geometry.py": "def calc_area(width, height):\n    return width * height\n",
      "report.py": "from geometry import calc_area\n\n\ndef describe(width, height):\n    return f'area={calc_area(width, height)}'\n",
      "test_report.py": "import unittest\n\nfrom report import describe\n\n\nclass ReportTest(unittest.TestCase):\n    def test_describe(self):\n        self.assertEqual(describe(2, 3), 'area=6')\n",
    },
    prompt: "Rename the function calc_area to rectangle_area everywhere in this repository, and make sure the tests still pass.",
    check: (dir) => {
      if (`${read(dir, "geometry.py")}${read(dir, "report.py")}`.includes("calc_area")) return "calc_area is still referenced";
      if (!read(dir, "geometry.py").includes("def rectangle_area")) return "rectangle_area is not defined";
      return unittest(dir);
    },
  },
  {
    id: "debug-log",
    title: "find a crash's cause from a log",
    files: {
      "app.py": "import configparser\n\nconfig = configparser.ConfigParser()\nconfig.read('settings.ini')\ntimeout = int(config['server']['timeout'])\nprint(f'starting with timeout {timeout}')\n",
      "settings.ini": "[server]\nhost = 127.0.0.1\ntimout = 30\n",
      "run.log": "$ python3 app.py\nTraceback (most recent call last):\n  File \"app.py\", line 5, in <module>\n    timeout = int(config['server']['timeout'])\nKeyError: 'timeout'\n",
    },
    prompt: "run.log shows app.py crashing. The code in app.py is correct. Find the cause and fix it so that python3 app.py runs.",
    check: (dir) => (run(dir, "python3", ["app.py"]).ok ? (read(dir, "app.py").includes("['timeout']") ? null : "app.py was changed") : "python3 app.py still fails"),
  },
  {
    id: "view-image",
    title: "describe an image (view_image)",
    files: { "screenshot.png": redDiscPng() },
    prompt: "What color is the shape in screenshot.png? Look at the image and answer with one word.",
    check: (_dir, outcome, events) => {
      if (!events.some((event) => event.type === "tool.started" && event.name === "view_image")) return "view_image was not used";
      return /red/i.test(outcome.lastMessage ?? "") ? null : "the answer does not say red";
    },
  },
  {
    id: "long-command",
    title: "follow a slow command (write_stdin)",
    files: { "slow.sh": "#!/bin/sh\necho starting\nsleep 15\necho RESULT=7319\n" },
    prompt: "Run ./slow.sh (it takes a while to finish; do not modify it) and tell me the RESULT value it prints.",
    check: (_dir, outcome) => ((outcome.lastMessage ?? "").includes("7319") ? null : "the answer does not contain 7319"),
  },
  {
    id: "many-steps",
    title: "a long trajectory (20+ tool calls)",
    files: Object.fromEntries(numbers.map((value, index) => [`data/${String(index + 1).padStart(2, "0")}.txt`, `${value}\n`])),
    prompt: "The directory data/ holds 20 files, each containing one number. Read them one file per command (cat each file separately, no loops or globs), keep a running total, then write the total into total.txt and tell me the total.",
    check: (dir) => (read(dir, "total.txt").trim() === String(numbers.reduce((sum, value) => sum + value, 0)) ? null : "total.txt is missing or wrong"),
  },
];

// --- runner ------------------------------------------------------------------------------

interface RequestMetric {
  index: number;
  status: string;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  /** Previous input + output tokens not served from cache (the prefix the server should have kept). */
  missedPrefixTokens: number | null;
  timeToFirstOutputMs: number | null;
  durationMs: number;
}

interface TaskReport {
  id: string;
  passed: boolean;
  reason: string | null;
  status: TurnOutcome["status"];
  error: string | null;
  requests: number;
  toolCalls: number;
  toolFailures: number;
  wallTimeMs: number;
  usage: TurnOutcome["usage"];
  medianTimeToFirstOutputMs: number | null;
  maxMissedPrefixTokens: number | null;
  sessionPath: string | null;
  perRequest: RequestMetric[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function setUp(task: Task): string {
  const dir = mkdtempSync(join(tmpdir(), `aporisa-task-${task.id}-`));
  for (const [path, contents] of Object.entries(task.files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), contents, { mode: path.endsWith(".sh") ? 0o755 : 0o644 });
  }
  run(dir, "git", ["init", "-q"]);
  run(dir, "git", ["add", "-A"]);
  run(dir, "git", ["-c", "user.name=aporisa", "-c", "user.email=aporisa@localhost", "commit", "-qm", "task"]);
  return dir;
}

async function runTask(task: Task, client: () => AporisaClient, model: string | undefined, host: NodeHost, persist: boolean): Promise<TaskReport> {
  const dir = setUp(task);
  const events: ThreadEvent[] = [];
  const started = performance.now();
  const connection = client();
  const thread = await Thread.start({ client: connection, host, cwd: dir, persist, maxRequestsPerTurn: MAX_REQUESTS, listener: (event) => events.push(event), ...(model ? { model } : {}) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);
  let outcome: TurnOutcome;
  try {
    outcome = await thread.runTurn(task.prompt, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    await thread.close();
    await connection.close();
  }
  const wallTimeMs = performance.now() - started;
  const reason = outcome.status === "completed" ? task.check(dir, outcome, events) : `turn ${outcome.status}${outcome.error ? ` (${outcome.error.code})` : ""}`;

  const perRequest: RequestMetric[] = [];
  let previous: Usage | null = null;
  for (const event of events) {
    if (event.type !== "response.completed") continue;
    const usage = event.usage;
    perRequest.push({
      index: event.requestIndex,
      status: event.status,
      inputTokens: usage?.input_tokens ?? null,
      cachedTokens: usage?.input_tokens_details.cached_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      missedPrefixTokens: usage && previous ? Math.max(0, previous.input_tokens + previous.output_tokens - usage.input_tokens_details.cached_tokens) : null,
      timeToFirstOutputMs: event.timeToFirstOutputMs,
      durationMs: event.durationMs,
    });
    previous = usage;
  }
  const tools = events.filter((event) => event.type === "tool.completed");
  const missed = perRequest.flatMap((request) => (request.missedPrefixTokens === null ? [] : [request.missedPrefixTokens]));
  rmSync(dir, { recursive: true, force: true });
  return {
    id: task.id,
    passed: reason === null,
    reason,
    status: outcome.status,
    error: outcome.error ? `${outcome.error.code}: ${outcome.error.message}` : null,
    requests: outcome.requests,
    toolCalls: tools.length,
    toolFailures: tools.filter((event) => event.type === "tool.completed" && !event.success).length,
    wallTimeMs,
    usage: outcome.usage,
    medianTimeToFirstOutputMs: median(perRequest.flatMap((request) => (request.timeToFirstOutputMs === null ? [] : [request.timeToFirstOutputMs]))),
    maxMissedPrefixTokens: missed.length > 0 ? Math.max(...missed) : null,
    sessionPath: thread.sessionPath,
    perRequest,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { only: { type: "string", multiple: true }, driver: { type: "string", default: "native" }, transport: { type: "string" } },
  });
  const selected = values.only?.length ? TASKS.filter((task) => values.only?.includes(task.id)) : TASKS;
  if (selected.length === 0) {
    console.error(`[Aporisa Code] ERROR: no such task; known: ${TASKS.map((task) => task.id).join(", ")}`);
    return 2;
  }
  let client: () => AporisaClient;
  let model: string | undefined;
  if (values.driver === "stub") {
    client = () => new StubDriver();
  } else {
    const env = loadEnv();
    if (!env.APORISA_BASE_URL || !env.APORISA_API_KEY) {
      console.error("[Aporisa Code] ERROR: set APORISA_BASE_URL and APORISA_API_KEY (aporisa_code/.env).");
      return 2;
    }
    const { APORISA_BASE_URL: baseUrl, APORISA_API_KEY: apiKey } = env;
    client = () => new NativeDriver({ baseUrl, apiKey, ...(values.transport === "http" ? { transport: "http" as const } : {}) });
    model = env.APORISA_MODEL;
  }

  const host = new NodeHost();
  const reports: TaskReport[] = [];
  for (const task of selected) {
    console.log(`[Aporisa Code] [WAIT] ${task.id}: ${task.title}`);
    const report = await runTask(task, client, model, host, values.driver !== "stub");
    reports.push(report);
    const label = report.passed ? "READY" : "MANUAL";
    console.log(
      `[Aporisa Code] [${label}] ${task.id} ${report.passed ? "passed" : `failed: ${report.reason}`} | ${report.requests} requests, ${report.toolCalls} tool calls (${report.toolFailures} failed), ${(report.wallTimeMs / 1000).toFixed(1)} s, median first output ${report.medianTimeToFirstOutputMs?.toFixed(0) ?? "-"} ms, cached ${report.usage.cachedTokens}/${report.usage.inputTokens} input tokens, max missed prefix ${report.maxMissedPrefixTokens ?? "-"} tokens`,
    );
  }
  const passed = reports.filter((report) => report.passed).length;
  console.log(`[Aporisa Code] [INFO] ${passed}/${reports.length} tasks passed.`);
  if (values.driver === "stub") return 0;
  const directory = join(import.meta.dirname, "..", "..", ".runtime", "agent-tasks");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, `${JSON.stringify({ driver: values.driver, model: model ?? null, reports }, null, 2)}\n`);
  console.log(`[Aporisa Code] [INFO] report: ${path}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
