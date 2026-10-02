// Electron main process (DEVELOPMENT_PLAN.md 10.3, 10.6): window, preload bridge, IPC,
// keychain, native dialogs and the app menu around the AppServer. Bundled by
// tools/build-electron.ts; `./frontend.sh dev` and the packaged app both start here.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { APPROVAL_RESULT, IPC, isClientMethod, PARAMS, type ApprovalDecision, type Language, type Notification, type ServerRequest } from "../app-protocol/index.ts";
import { loadEnv, NodeHost } from "../host/index.ts";
import { NativeDriver } from "../sdk/index.ts";
import { AppError, AppServer } from "./app-server.ts";
import { CredentialStore, type Encryptor } from "./credentials.ts";
import { isTrustedRendererUrl, rendererUrl } from "./renderer-url.ts";
import { ProjectStore } from "./projects.ts";
import { SettingsStore } from "./settings.ts";
import { resolveShellEnvironment } from "./shell-env.ts";

const development = process.env.APORISA_DEV === "1";
const APP_NAME = "Aporisa Code";

// Chromium's own profile (caches, local storage) stays out of the app's data directory,
// which the sandbox denies to commands and which holds sessions and credentials.
app.setName(APP_NAME);
app.setPath("userData", join(app.getPath("appData"), APP_NAME, "Electron"));

const keychain: Encryptor = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (cipher) => safeStorage.decryptString(cipher),
};

let window: BrowserWindow | null = null;
let server: AppServer | null = null;
let settingsStore: SettingsStore | null = null;
let quitting = false;
let nextRequestId = 1;
const pending = new Map<number, (decision: ApprovalDecision) => void>();

function send(notification: Notification): void {
  window?.webContents.send(IPC.notification, notification);
}

function requestApproval(params: ServerRequest["params"]): Promise<ApprovalDecision> {
  if (!window) return Promise.resolve("denied");
  const id = nextRequestId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const request: ServerRequest = { id, method: "approval/request", params };
    window?.webContents.send(IPC.serverRequest, request);
  });
}

function answerPendingWithDenial(): void {
  for (const resolve of pending.values()) resolve("denied");
  pending.clear();
}

const MENU_LABELS: Record<Language, Record<string, string>> = {
  en: { settings: "Settings…", newThread: "New Thread", file: "File", edit: "Edit", view: "View", window: "Window" },
  "zh-CN": { settings: "设置…", newThread: "新建会话", file: "文件", edit: "编辑", view: "显示", window: "窗口" },
};

function buildMenu(language: Language): void {
  const label = MENU_LABELS[language];
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: label.settings, accelerator: "Cmd+,", click: () => send({ method: "app/command", params: { command: "openSettings" } }) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: label.file, submenu: [{ label: label.newThread, accelerator: "Cmd+N", click: () => send({ method: "app/command", params: { command: "newThread" } }) }, { role: "close" }] },
    { label: label.edit, role: "editMenu" },
    {
      label: label.view,
      submenu: development
        ? [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }]
        : [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
    { label: label.window, role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function applyDeviceSettings(settings: SettingsStore): void {
  const { appearance, language } = settings.snapshot().device;
  nativeTheme.themeSource = appearance;
  buildMenu(language);
}

async function createServer(): Promise<{ server: AppServer; settings: SettingsStore }> {
  // Started from Finder or the Dock, the app lacks the user's shell PATH (shell-env.ts).
  if (!development) {
    const environment = await resolveShellEnvironment(process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/zsh");
    if (environment) Object.assign(process.env, environment);
  }
  const host = new NodeHost();
  const dataDir = host.info().dataDir;
  const env = development && process.env.APORISA_ENV_FILE ? loadEnv(process.env.APORISA_ENV_FILE) : {};
  const settings = new SettingsStore(dataDir);
  await settings.load();
  const projects = new ProjectStore(dataDir);
  await projects.load();
  applyDeviceSettings(settings);
  const created = new AppServer({
    host,
    settings,
    credentials: new CredentialStore(dataDir, keychain, env.APORISA_API_KEY ?? null),
    createClient: (baseUrl, apiKey) => new NativeDriver({ baseUrl, apiKey }),
    notify: send,
    requestApproval,
    selectFolder: async () => {
      const result = window ? await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] }) : null;
      return result && !result.canceled ? (result.filePaths[0] ?? null) : null;
    },
    reveal: (path) => shell.showItemInFolder(path),
    projects,
    // Outside the data directory: the sandbox does not let commands read that one.
    scratchDir: join(app.getPath("home"), "Library", "Caches", APP_NAME, "scratch"),
    trash: (path) => shell.trashItem(path),
    appVersion: app.getVersion(),
    development,
    envBaseUrl: env.APORISA_BASE_URL ?? null,
    envModel: env.APORISA_MODEL ?? null,
  });
  return { server: created, settings };
}

/** The Vite dev server, only in development. */
const devRendererUrl = development ? (process.env.APORISA_RENDERER_URL ?? null) : null;

function trusted(url: string): boolean {
  return isTrustedRendererUrl(url, __dirname, devRendererUrl);
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    title: APP_NAME,
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  created.once("ready-to-show", () => created.show());
  // The renderer never navigates away or opens windows; external links go to the browser.
  created.webContents.on("will-navigate", (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  created.on("closed", () => {
    answerPendingWithDenial();
    window = null;
  });
  void created.loadURL(rendererUrl(__dirname, devRendererUrl));
  return created;
}

ipcMain.handle(IPC.request, async (event, message: { method?: unknown; params?: unknown }) => {
  if (!event.senderFrame || !trusted(event.senderFrame.url)) return { ok: false, error: { code: "internal", message: "untrusted sender" } };
  if (!server) return { ok: false, error: { code: "internal", message: "the app is starting" } };
  if (!isClientMethod(message.method)) return { ok: false, error: { code: "unknown_method", message: `unknown method ${String(message.method)}` } };
  const parsed = PARAMS[message.method].safeParse(message.params ?? {});
  if (!parsed.success) return { ok: false, error: { code: "invalid_params", message: parsed.error.issues[0]?.message ?? "invalid params" } };
  try {
    const result = await server.handle(message.method, parsed.data as never);
    if (message.method === "settings/update" && settingsStore) applyDeviceSettings(settingsStore);
    return { ok: true, result };
  } catch (error) {
    const code = error instanceof AppError ? error.code : "internal";
    return { ok: false, error: { code, message: (error as Error).message } };
  }
});

ipcMain.on(IPC.serverResponse, (event, message: { id?: unknown; result?: unknown }) => {
  if (!event.senderFrame || !trusted(event.senderFrame.url) || typeof message.id !== "number") return;
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  const parsed = APPROVAL_RESULT.safeParse(message.result);
  resolve(parsed.success ? parsed.data.decision : "denied");
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (quitting || !server) return;
  event.preventDefault();
  quitting = true;
  answerPendingWithDenial();
  void server.dispose().finally(() => app.quit());
});

void app.whenReady().then(async () => {
  ({ server, settings: settingsStore } = await createServer());
  window = createWindow();
  app.on("activate", () => {
    if (!window) window = createWindow();
  });
});
