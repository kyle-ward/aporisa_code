// aporisa_code/.env: deployment differences only (AGENTS.md; DEVELOPMENT_PLAN.md FD-12).
// Variables already set in the environment win over the file. The packaged app does not
// read it; the CLI, the user-run tools and the app's development mode do.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ENV_KEYS = ["APORISA_BASE_URL", "APORISA_API_KEY", "APORISA_MODEL", "OPENROUTER_API_KEY"] as const;
export type EnvKey = (typeof ENV_KEYS)[number];

/** aporisa_code/.env, resolved from this module (computed on use: bundles have no import.meta.url). */
export function defaultEnvFile(): string {
  return fileURLToPath(new URL("../../.env", import.meta.url));
}

/** Parses KEY=VALUE lines; `#` comments and blank lines are skipped, quotes stripped. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`.env line ${index + 1} is not KEY=VALUE`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

/** Known keys from the process environment, falling back to the .env file. Unknown keys are rejected. */
export function loadEnv(path = defaultEnvFile(), environment: NodeJS.ProcessEnv = process.env): Partial<Record<EnvKey, string>> {
  let file: Record<string, string> = {};
  try {
    file = parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  const unknown = Object.keys(file).filter((key) => !(ENV_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new Error(`unknown keys in ${path}: ${unknown.join(", ")}`);
  const result: Partial<Record<EnvKey, string>> = {};
  for (const key of ENV_KEYS) {
    const value = environment[key] ?? file[key];
    if (value !== undefined && value !== "") result[key] = value;
  }
  return result;
}
