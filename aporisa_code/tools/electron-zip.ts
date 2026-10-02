// The Electron release zip that @electron/packager builds the app from
// (DEVELOPMENT_PLAN.md 10.6). It lives in the project cache (.cache/electron), never the
// user's global cache.
//   fetch   (prepare only, networked): download into the cache if missing, verified
//           against node_modules/electron/checksums.json; prints the zip's directory.
//   locate  (build, offline): find the cached zip and verify its SHA256; prints its directory.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = join(root, ".cache", "electron");
const electronDir = join(root, "node_modules", "electron");
const version = (JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8")) as { version: string }).version;
const checksums = JSON.parse(readFileSync(join(electronDir, "checksums.json"), "utf8")) as Record<string, string>;
const zipName = `electron-v${version}-darwin-arm64.zip`;

function fail(message: string): never {
  console.error(`[Aporisa Code] ERROR: ${message}`);
  process.exit(1);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function locate(): Promise<string | null> {
  if (!existsSync(cacheRoot)) return null;
  const expected = checksums[zipName] ?? fail(`checksums.json does not list ${zipName}.`);
  for (const entry of readdirSync(cacheRoot)) {
    const candidate = join(cacheRoot, entry, zipName);
    if (!existsSync(candidate)) continue;
    if ((await sha256(candidate)) !== expected) fail(`${candidate} does not match its pinned SHA256; delete it and run prepare.`);
    return dirname(candidate);
  }
  return null;
}

const mode = process.argv[2];
if (mode === "locate") {
  const found = await locate();
  if (!found) fail(`${zipName} is not in .cache/electron; run ./frontend.sh prepare.`);
  console.log(found);
} else if (mode === "fetch") {
  const { downloadArtifact } = await import("@electron/get");
  const zip = await downloadArtifact({ version, artifactName: "electron", platform: "darwin", arch: "arm64", cacheRoot, checksums });
  const found = await locate();
  if (!found || join(found, zipName) !== zip) fail(`Electron zip is not where expected after download: ${zip}`);
  console.log(found);
} else {
  fail("Usage: node tools/electron-zip.ts fetch|locate");
}
