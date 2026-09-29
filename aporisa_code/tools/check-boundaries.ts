// Enforces the frontend dependency direction (AGENTS.md):
//   ui → (IPC) → main → harness → sdk → protocol, harness touches the system only via host.
// Each top-level directory under src/ may import only the modules and packages listed here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface Rule {
  modules: string[];
  packages: string[];
  nodeBuiltins: boolean;
}

const RULES: Record<string, Rule> = {
  protocol: { modules: ["protocol"], packages: ["zod"], nodeBuiltins: false },
  sdk: { modules: ["sdk", "protocol"], packages: ["ws"], nodeBuiltins: true },
  mock: { modules: ["mock", "sdk", "protocol"], packages: ["ws", "zod"], nodeBuiltins: true },
  conformance: { modules: ["conformance", "sdk", "protocol"], packages: ["ws"], nodeBuiltins: true },
  host: { modules: ["host", "protocol"], packages: [], nodeBuiltins: true },
  harness: { modules: ["harness", "host", "sdk", "protocol"], packages: [], nodeBuiltins: false },
  cli: { modules: ["cli", "harness", "host", "sdk", "mock", "protocol"], packages: [], nodeBuiltins: true },
  main: { modules: ["main", "harness", "host", "sdk", "protocol"], packages: ["electron"], nodeBuiltins: true },
  preload: { modules: ["preload", "protocol"], packages: ["electron"], nodeBuiltins: false },
  ui: { modules: ["ui", "protocol"], packages: [], nodeBuiltins: false },
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(packageRoot, "src");
const IMPORT_PATTERN = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

const violations: string[] = [];
for (const file of walk(srcRoot)) {
  const owner = relative(srcRoot, file).split(sep)[0] ?? "";
  const rule = RULES[owner];
  if (!rule) {
    violations.push(`${relative(packageRoot, file)}: src/${owner} has no boundary rule; add one to tools/check-boundaries.ts`);
    continue;
  }
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? "";
    let allowed: boolean;
    if (specifier.startsWith(".")) {
      const target = relative(srcRoot, resolve(dirname(file), specifier));
      const targetModule = target.split(sep)[0] ?? "";
      allowed = !target.startsWith("..") && rule.modules.includes(targetModule);
    } else if (specifier.startsWith("node:")) {
      allowed = rule.nodeBuiltins;
    } else {
      allowed = rule.packages.includes(packageName(specifier));
    }
    if (!allowed) violations.push(`${relative(packageRoot, file)}: src/${owner} must not import '${specifier}'`);
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`[Aporisa] ERROR: ${violation}`);
  process.exit(1);
}
console.log("[Aporisa] [READY] Import boundaries respected.");
