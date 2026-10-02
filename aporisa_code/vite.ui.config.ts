// Renderer build (DEVELOPMENT_PLAN.md 10.6): React UI from src/ui into dist/app/renderer.
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Strict CSP for the packaged renderer. Development leaves it out: Vite injects inline scripts. */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

function contentSecurityPolicy(): Plugin {
  return {
    name: "aporisa-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY }, injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  root: "src/ui",
  base: "./",
  plugins: [react(), contentSecurityPolicy()],
  server: { port: 5199, strictPort: true },
  build: { outDir: "../../dist/app/renderer", emptyOutDir: true, sourcemap: true },
});
