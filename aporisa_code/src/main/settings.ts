// App settings (DEVELOPMENT_PLAN.md FD-20, FD-23). Two versioned files, read through one
// store so a database or per-account storage can replace them later:
// - device settings (language, appearance, connection): <dataDir>/settings.json
// - account preferences (new-thread defaults): <dataDir>/profiles/local/preferences.json
// Credentials are not here (credentials.ts).
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DeviceSettings, ThreadSettings } from "../app-protocol/index.ts";
import { profileDir } from "../harness/index.ts";

export const DEFAULT_BASE_URL = "http://127.0.0.1:18080/v1";

const DeviceFile = z.object({
  version: z.literal(1),
  language: z.enum(["en", "zh-CN"]).catch("en"),
  appearance: z.enum(["system", "light", "dark"]).catch("system"),
  /** Connections as a list (FD-24); the MVP has one, the local backend. */
  connections: z
    .array(z.object({ id: z.string(), kind: z.literal("native"), baseUrl: z.string().nullable() }))
    .catch([{ id: "local", kind: "native", baseUrl: null }]),
  activeConnection: z.string().catch("local"),
});

const PreferencesFile = z.object({
  version: z.literal(1),
  newThread: z
    .object({
      effort: z.enum(["none", "low", "medium", "high"]).nullable().catch(null),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).catch("workspace-write"),
      approval: z.enum(["untrusted", "on-request", "never"]).catch("on-request"),
      network: z.boolean().catch(false),
    })
    .catch({ effort: null, sandbox: "workspace-write", approval: "on-request", network: false }),
});

export type DeviceFile = z.infer<typeof DeviceFile>;
export type PreferencesFile = z.infer<typeof PreferencesFile>;

const DEVICE_DEFAULTS: DeviceFile = { version: 1, language: "en", appearance: "system", connections: [{ id: "local", kind: "native", baseUrl: null }], activeConnection: "local" };
const PREFERENCE_DEFAULTS: PreferencesFile = { version: 1, newThread: { effort: null, sandbox: "workspace-write", approval: "on-request", network: false } };

export async function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return structuredClone(fallback);
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

/** Atomic, private write. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export interface SettingsSnapshot {
  device: DeviceSettings;
  /** The active connection's configured base URL (null: default). */
  baseUrl: string | null;
  /** New-thread defaults; effort null means the model's default. */
  newThread: Omit<ThreadSettings, "effort"> & { effort: ThreadSettings["effort"] | null };
}

export class SettingsStore {
  readonly devicePath: string;
  readonly preferencesPath: string;
  private device: DeviceFile = structuredClone(DEVICE_DEFAULTS);
  private preferences: PreferencesFile = structuredClone(PREFERENCE_DEFAULTS);

  constructor(dataDir: string) {
    this.devicePath = join(dataDir, "settings.json");
    this.preferencesPath = join(profileDir(dataDir), "preferences.json");
  }

  async load(): Promise<SettingsSnapshot> {
    this.device = await readJson(this.devicePath, DeviceFile, DEVICE_DEFAULTS);
    this.preferences = await readJson(this.preferencesPath, PreferencesFile, PREFERENCE_DEFAULTS);
    return this.snapshot();
  }

  snapshot(): SettingsSnapshot {
    const connection = this.device.connections.find((entry) => entry.id === this.device.activeConnection) ?? this.device.connections[0];
    return {
      device: { language: this.device.language, appearance: this.device.appearance },
      baseUrl: connection?.baseUrl ?? null,
      newThread: { ...this.preferences.newThread },
    };
  }

  async update(change: { device?: Partial<DeviceSettings>; baseUrl?: string | null; newThread?: Partial<SettingsSnapshot["newThread"]> }): Promise<SettingsSnapshot> {
    if (change.device || change.baseUrl !== undefined) {
      if (change.device?.language) this.device.language = change.device.language;
      if (change.device?.appearance) this.device.appearance = change.device.appearance;
      if (change.baseUrl !== undefined) {
        const connection = this.device.connections.find((entry) => entry.id === this.device.activeConnection);
        if (connection) connection.baseUrl = change.baseUrl;
      }
      await writePrivateJson(this.devicePath, this.device);
    }
    if (change.newThread) {
      this.preferences.newThread = { ...this.preferences.newThread, ...change.newThread };
      await writePrivateJson(this.preferencesPath, this.preferences);
    }
    return this.snapshot();
  }
}
