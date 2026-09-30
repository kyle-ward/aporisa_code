// Regenerates docs/schema/aporisa-protocol-v0.schema.json from the zod definitions.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderProtocolSchema, SCHEMA_RELATIVE_PATH } from "../src/protocol/schema.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(packageRoot, SCHEMA_RELATIVE_PATH);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderProtocolSchema());
console.log(`[Aporisa Code] [READY] Protocol schema written: ${target}`);
