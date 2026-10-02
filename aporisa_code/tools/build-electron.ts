// Bundles the Electron main process and preload into dist/app (DEVELOPMENT_PLAN.md 10.6).
// Offline: esbuild only. The renderer is built by Vite (vite.ui.config.ts) into
// dist/app/renderer. `--watch` rebuilds on change for ./frontend.sh dev.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context, type BuildOptions } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "app");
const watch = process.argv.includes("--watch");
const pkg = (await import(join(root, "package.json"), { with: { type: "json" } })).default as { version: string; description: string };

const common: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: "linked",
  logLevel: "warning",
};

const targets: BuildOptions[] = [
  {
    ...common,
    entryPoints: [join(root, "src", "main", "electron.ts")],
    outfile: join(out, "main.cjs"),
    // The bundle is CommonJS: give modules that read import.meta.url their own file URL.
    define: { "import.meta.url": "__aporisa_import_meta_url" },
    banner: { js: 'const __aporisa_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  },
  // The preload runs sandboxed: no __filename and only a few requirable modules, so it
  // gets no banner and must import nothing but electron and type-only modules.
  { ...common, entryPoints: [join(root, "src", "preload", "preload.ts")], outfile: join(out, "preload.cjs") },
];

mkdirSync(out, { recursive: true });
// What @electron/packager packages: the bundles only, no node_modules.
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify({ name: "aporisa-code", productName: "Aporisa Code", version: pkg.version, description: pkg.description, main: "main.cjs" }, null, 2)}\n`,
);

if (watch) {
  for (const target of targets) await (await context(target)).watch();
  console.log("[Aporisa Code] [READY] Watching main and preload.");
} else {
  await Promise.all(targets.map((target) => build(target)));
  console.log("[Aporisa Code] [READY] Bundled main and preload into dist/app.");
}
