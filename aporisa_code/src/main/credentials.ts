// Credentials (FD-16, FD-24): encrypted with the system keychain (Electron safeStorage in
// the app) and stored as <dataDir>/credentials.json (0600). The renderer never receives a
// credential: only whether one is configured and its last four characters. A credential
// provider resolves the key for each request, so tokens that refresh can replace it later.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateJson } from "./settings.ts";

/** What encrypts at rest; Electron's safeStorage in the app, a fake in tests. */
export interface Encryptor {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

interface CredentialFile {
  version: 1;
  entries: Record<string, string>;
}

export interface CredentialView {
  configured: boolean;
  hint: string | null;
  source: "keychain" | "env" | null;
}

export class CredentialStore {
  readonly path: string;
  private readonly encryptor: Encryptor;
  /** aporisa_code/.env values (development mode only). */
  private readonly envFallback: string | null;

  constructor(dataDir: string, encryptor: Encryptor, envFallback: string | null = null) {
    this.path = join(dataDir, "credentials.json");
    this.encryptor = encryptor;
    this.envFallback = envFallback;
  }

  private async read(): Promise<CredentialFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as CredentialFile;
      return parsed.version === 1 && typeof parsed.entries === "object" ? parsed : { version: 1, entries: {} };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  async stored(connectionId: string): Promise<string | null> {
    const entry = (await this.read()).entries[connectionId];
    if (!entry || !this.encryptor.available()) return null;
    try {
      return this.encryptor.decrypt(Buffer.from(entry, "base64"));
    } catch {
      return null;
    }
  }

  /** The key to send: the stored one, else the development fallback. */
  async get(connectionId: string): Promise<string | null> {
    return (await this.stored(connectionId)) ?? this.envFallback;
  }

  /** Stores (or with "" removes) a key. */
  async set(connectionId: string, secret: string): Promise<void> {
    const file = await this.read();
    if (secret === "") {
      delete file.entries[connectionId];
    } else {
      if (!this.encryptor.available()) throw new Error("the system keychain is not available to encrypt the key");
      file.entries[connectionId] = this.encryptor.encrypt(secret).toString("base64");
    }
    await writePrivateJson(this.path, file);
  }

  async describe(connectionId: string): Promise<CredentialView> {
    const stored = await this.stored(connectionId);
    const key = stored ?? this.envFallback;
    if (!key) return { configured: false, hint: null, source: null };
    return { configured: true, hint: key.slice(-4), source: stored ? "keychain" : "env" };
  }
}
