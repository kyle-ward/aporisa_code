// `aporisa`: the headless CLI over the harness (DEVELOPMENT_PLAN.md 7.1).
//   npm run aporisa -- exec "<task>"      one turn, then exit
//   npm run aporisa --                     interactive: one line per message
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { imageMediaType, MAX_IMAGE_BYTES, Thread, type ApprovalRequest, type UserInput } from "../harness/index.ts";
import { NodeHost } from "../host/index.ts";
import { StubDriver } from "../mock/index.ts";
import type { InputImagePart, InputTextPart, ReasoningEffort } from "../protocol/index.ts";
import { NativeDriver, type AporisaClient } from "../sdk/index.ts";
import { ENV_FILE, loadEnv } from "./env.ts";
import { approvalQuestion, processOutput, renderer, type Output } from "./render.ts";

export const USAGE = `Usage:
  npm run aporisa -- exec [options] <task...>   Run one turn and exit ("-" reads the task from stdin)
  npm run aporisa -- [options]                  Interactive session (/effort <level>, /exit)

Options:
  --cwd <dir>            Working directory (default: where npm was run)
  --model <alias>        Model alias (default: APORISA_MODEL, else the first listed model)
  --effort <level>       Reasoning effort (none, low, medium, high)
  --resume <id|path>     Continue a saved thread
  --image <path>         Attach a PNG or JPEG to the task (repeatable)
  --auto                 Run commands and patches without asking. Use only in a throwaway directory:
                         F2 has no sandbox yet; commands run as you.
  --json                 Print events as JSONL on stdout
  --show-reasoning       Print the model's reasoning on stderr
  --no-persist           Do not write the session record
  --max-requests <n>     Model requests allowed per turn (default 200)
  --driver native|stub   stub answers with an echo, without a backend (default native)
  --transport websocket|http
  -h, --help

Connection: APORISA_BASE_URL, APORISA_API_KEY and APORISA_MODEL from the environment or ${ENV_FILE}.`;

const EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];

export class UsageError extends Error {}

export interface CliIo {
  output: Output;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Directory the user ran the command from. */
  invocationDir: string;
  colors: boolean;
}

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      resume: { type: "string" },
      image: { type: "string", multiple: true },
      auto: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "show-reasoning": { type: "boolean", default: false },
      "no-persist": { type: "boolean", default: false },
      "max-requests": { type: "string" },
      driver: { type: "string", default: "native" },
      transport: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (command !== undefined && command !== "exec") throw new UsageError(`unknown command '${command}'`);
  if (values.effort !== undefined && !EFFORTS.includes(values.effort as ReasoningEffort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}`);
  if (values.driver !== "native" && values.driver !== "stub") throw new UsageError("--driver must be native or stub");
  if (values.transport !== undefined && values.transport !== "websocket" && values.transport !== "http") throw new UsageError("--transport must be websocket or http");
  const maxRequests = values["max-requests"] === undefined ? undefined : Number(values["max-requests"]);
  if (maxRequests !== undefined && (!Number.isInteger(maxRequests) || maxRequests < 1)) throw new UsageError("--max-requests must be a positive integer");
  return { values, command: command ?? "interactive", task: rest, maxRequests };
}

function readImages(paths: readonly string[], base: string): InputImagePart[] {
  return paths.map((path) => {
    const bytes = readFileSync(resolve(base, path));
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new UsageError(`${path} is larger than ${MAX_IMAGE_BYTES} bytes`);
    const mediaType = imageMediaType(bytes);
    if (!mediaType) throw new UsageError(`${path} is not a PNG or JPEG image`);
    return { type: "input_image", image_url: `data:${mediaType};base64,${bytes.toString("base64")}`, detail: "auto" };
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  return text;
}

function connect(driver: string, transport: string | undefined): { client: AporisaClient; model: string | undefined } {
  if (driver === "stub") return { client: new StubDriver(), model: undefined };
  const env = loadEnv();
  if (!env.APORISA_BASE_URL || !env.APORISA_API_KEY) {
    throw new UsageError(`set APORISA_BASE_URL and APORISA_API_KEY (environment or ${ENV_FILE}; see .env.example)`);
  }
  const client = new NativeDriver({
    baseUrl: env.APORISA_BASE_URL,
    apiKey: env.APORISA_API_KEY,
    ...(transport === "http" ? { transport: "http" as const } : {}),
  });
  return { client, model: env.APORISA_MODEL };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.output.err(`ERROR: ${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const { values, command, task, maxRequests } = parsed;
  if (values.help) {
    io.output.out(`${USAGE}\n`);
    return 0;
  }

  const cwd = values.cwd ? resolve(io.invocationDir, values.cwd) : io.invocationDir;
  let images: InputImagePart[];
  let client: AporisaClient;
  let model: string | undefined;
  try {
    images = readImages(values.image ?? [], io.invocationDir);
    ({ client, model } = connect(values.driver, values.transport));
  } catch (error) {
    io.output.err(`ERROR: ${(error as Error).message}\n`);
    return 2;
  }
  model = values.model ?? model;

  let text = task.join(" ");
  if (command === "exec" && (text === "" || text === "-")) {
    if (io.stdin.isTTY) {
      io.output.err(`ERROR: exec needs a task (or "-" with the task on stdin)\n`);
      return 2;
    }
    text = (await readAll(io.stdin)).trim();
  }
  if (command === "exec" && text === "" && images.length === 0) {
    io.output.err("ERROR: the task is empty\n");
    return 2;
  }

  const interactive = command === "interactive";
  const terminal = io.stdin.isTTY === true;
  let rl: Interface | null = null;
  const lines = (): Interface => {
    if (!rl) {
      rl = createInterface({ input: io.stdin, output: process.stderr, terminal });
      rl.on("SIGINT", interrupt);
    }
    return rl;
  };

  let turn: AbortController | null = null;
  let interrupts = 0;
  function interrupt(): void {
    if (turn && !turn.signal.aborted) {
      io.output.err("\n[Aporisa Code] [INFO] interrupting the turn (Ctrl-C again to quit)\n");
      turn.abort();
      return;
    }
    interrupts += 1;
    if (!interactive || interrupts > 1 || !turn) {
      rl?.close();
      process.exit(130);
    }
  }
  process.on("SIGINT", interrupt);

  let warnedNoTerminal = false;
  const approve = values.auto
    ? undefined
    : async (request: ApprovalRequest): Promise<boolean> => {
        if (!terminal) {
          if (!warnedNoTerminal) io.output.err("[Aporisa Code] [MANUAL] stdin is not a terminal, so commands and patches cannot be approved; they are refused. Use --auto only in a throwaway directory.\n");
          warnedNoTerminal = true;
          return false;
        }
        const answer = await lines().question(approvalQuestion(request));
        return /^y(es)?$/i.test(answer.trim());
      };

  const host = new NodeHost();
  const listener = renderer(io.output, { json: values.json, showReasoning: values["show-reasoning"], color: io.colors && !values.json });
  const common = {
    client,
    host,
    listener,
    persist: !values["no-persist"],
    ...(approve ? { approve } : {}),
    ...(values.effort ? { effort: values.effort as ReasoningEffort } : {}),
    ...(maxRequests !== undefined ? { maxRequestsPerTurn: maxRequests } : {}),
  };

  let thread: Thread;
  try {
    if (!isAbsolute(cwd)) throw new Error(`cannot resolve ${cwd}`);
    thread = values.resume
      ? await Thread.resume({ ...common, session: values.resume })
      : await Thread.start({ ...common, cwd, ...(model ? { model } : {}) });
  } catch (error) {
    io.output.err(`ERROR: ${(error as Error).message}\n`);
    await client.close();
    return 1;
  }

  const runOne = async (input: UserInput): Promise<number> => {
    turn = new AbortController();
    try {
      const outcome = await thread.runTurn(input, { signal: turn.signal });
      return outcome.status === "completed" ? 0 : outcome.status === "interrupted" ? 130 : 1;
    } finally {
      turn = null;
    }
  };

  let code = 0;
  try {
    if (!interactive) {
      const content: (InputTextPart | InputImagePart)[] = [...(text ? [{ type: "input_text" as const, text }] : []), ...images];
      code = await runOne(content);
    } else {
      io.output.err(`[Aporisa Code] [READY] thread ${thread.id}. One line per message; /effort <level>, /exit.\n`);
      let pendingImages = images;
      for (;;) {
        let line: string;
        try {
          line = (await lines().question("› ")).trim();
        } catch {
          break; // stdin closed
        }
        if (line === "") continue;
        if (line === "/exit" || line === "/quit") break;
        if (line.startsWith("/effort")) {
          const level = line.split(/\s+/)[1] as ReasoningEffort | undefined;
          if (!level || !EFFORTS.includes(level)) io.output.err(`ERROR: /effort takes one of ${EFFORTS.join(", ")}\n`);
          else {
            thread.setEffort(level);
            io.output.err(`[Aporisa Code] [INFO] effort ${level} from the next message\n`);
          }
          continue;
        }
        code = await runOne([{ type: "input_text", text: line }, ...pendingImages]);
        pendingImages = [];
        interrupts = 0;
      }
    }
  } finally {
    process.off("SIGINT", interrupt);
    (rl as Interface | null)?.close();
    await thread.close();
    await client.close();
    if (thread.sessionPath && !values.json) io.output.err(`[Aporisa Code] [INFO] session saved: ${thread.sessionPath} (resume with --resume ${thread.id})\n`);
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runCli(process.argv.slice(2), {
    output: processOutput,
    stdin: process.stdin,
    invocationDir: process.env.INIT_CWD ?? process.cwd(),
    colors: process.stderr.isTTY === true,
  });
  process.exit(code);
}
