// The committed JSON Schema must match the zod source of truth (docs/protocol.md §13).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { renderProtocolSchema, SCHEMA_RELATIVE_PATH } from "../src/protocol/schema.ts";

it("docs/schema is up to date (run `npm run schema:export` after changing src/protocol)", () => {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const committed = readFileSync(resolve(packageRoot, SCHEMA_RELATIVE_PATH), "utf8");
  expect(committed).toBe(renderProtocolSchema());
});
