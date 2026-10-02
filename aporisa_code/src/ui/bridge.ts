// The L3 bridge: window.aporisa from the preload in the app. Only the Vite dev server in a
// plain browser (UI checks during development) falls back to a scripted mock; production
// builds never include it.
import type { AporisaBridge } from "../app-protocol/types.ts";

declare global {
  interface Window {
    aporisa?: AporisaBridge;
  }
}

export async function loadBridge(): Promise<AporisaBridge> {
  if (window.aporisa) return window.aporisa;
  if (import.meta.env.DEV) return (await import("./dev/mock-bridge.ts")).createMockBridge();
  throw new Error("The Aporisa bridge is missing.");
}
