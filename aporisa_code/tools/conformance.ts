// Runs the wire conformance suite against a live server (e.g. the real backend on the
// Studio). Networked and user-run only; never part of scripts/check.sh.
//   APORISA_BASE_URL=http://studio:18080/v1 APORISA_API_KEY=... APORISA_MODEL=... \
//     node tools/conformance.ts
import { runWireConformance } from "../src/conformance/wire.ts";

const baseUrl = process.env.APORISA_BASE_URL;
const apiKey = process.env.APORISA_API_KEY;
const model = process.env.APORISA_MODEL;
if (!baseUrl || !apiKey || !model) {
  console.error("[Aporisa Code] ERROR: set APORISA_BASE_URL, APORISA_API_KEY and APORISA_MODEL.");
  process.exit(2);
}

const results = await runWireConformance({ baseUrl, apiKey, model });
for (const result of results) {
  const label = result.status === "pass" ? "READY" : result.status === "skip" ? "INFO" : "MANUAL";
  console.log(`[Aporisa Code] [${label}] ${result.id} ${result.status} - ${result.title}${result.detail ? ` (${result.detail})` : ""}`);
}
const failed = results.filter((result) => result.status === "fail").length;
console.log(`[Aporisa Code] [INFO] ${results.length - failed} passed or skipped, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
