// Packages dist/app into release/Aporisa Code-darwin-arm64/Aporisa Code.app with
// @electron/packager (DEVELOPMENT_PLAN.md 10.6). Offline: the Electron zip comes from
// `node tools/electron-zip.ts locate`, passed as the first argument. Signing is done
// afterwards by frontend.sh (ad-hoc, codesign -s -).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "dist", "app");
const zipDir = process.argv[2];

function fail(message: string): never {
  console.error(`[Aporisa Code] ERROR: ${message}`);
  process.exit(1);
}

if (!zipDir) fail("Usage: node tools/package-app.ts <electron-zip-dir>");
for (const required of ["main.cjs", "preload.cjs", "package.json", join("renderer", "index.html")]) {
  if (!existsSync(join(appDir, required))) fail(`dist/app/${required} is missing; build main and renderer first.`);
}

const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const electronVersion = (JSON.parse(readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8")) as { version: string }).version;

const [bundle] = await packager({
  dir: appDir,
  out: join(root, "release"),
  overwrite: true,
  platform: "darwin",
  arch: "arm64",
  electronVersion,
  electronZipDir: zipDir,
  name: "Aporisa Code",
  executableName: "Aporisa Code",
  appBundleId: "local.aporisa.code",
  appVersion: version,
  appCategoryType: "public.app-category.developer-tools",
  asar: true,
  prune: false,
  junk: true,
  // Source maps stay out of the shipped app.
  ignore: [/\.map$/],
  quiet: true,
});
if (!bundle) fail("Packager produced no output.");
console.log(join(bundle, "Aporisa Code.app"));
