// Where the renderer is loaded from, and which frame URLs the main process trusts for IPC.
// Pure (no Electron) so it is tested directly. Chromium reports frame URLs percent-encoded
// ("Aporisa%20Code.app"), so the packaged prefix must be built as a file URL, never by
// gluing a raw path after "file://".
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function rendererUrl(appDir: string, devUrl: string | null): string {
  return devUrl ?? pathToFileURL(join(appDir, "renderer", "index.html")).href;
}

/** True for frames showing the packaged renderer, or the dev server in development. */
export function isTrustedRendererUrl(url: string, appDir: string, devUrl: string | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (devUrl !== null) return parsed.origin === new URL(devUrl).origin;
  const prefix = `${pathToFileURL(join(appDir, "renderer")).href}/`;
  return parsed.protocol === "file:" && parsed.href.startsWith(prefix);
}
