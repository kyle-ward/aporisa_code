// The renderer's only door to the app (DEVELOPMENT_PLAN.md 10.3): a narrow bridge exposed
// as window.aporisa. It forwards L3 requests, notifications and approval answers; it never
// exposes Node, Electron or credentials. Runs sandboxed: only "electron" can be required.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type AporisaBridge, type Notification, type ServerRequest } from "../app-protocol/types.ts";

interface Reply {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

const bridge: AporisaBridge = {
  async request(method, params) {
    const reply = (await ipcRenderer.invoke(IPC.request, { method, params })) as Reply;
    if (!reply.ok) throw Object.assign(new Error(reply.error?.message ?? "request failed"), { code: reply.error?.code ?? "internal" });
    return reply.result as never;
  },
  onNotification(listener) {
    const handler = (_event: IpcRendererEvent, notification: Notification) => listener(notification);
    ipcRenderer.on(IPC.notification, handler);
    return () => ipcRenderer.off(IPC.notification, handler);
  },
  onServerRequest(listener) {
    const handler = (_event: IpcRendererEvent, request: ServerRequest) => listener(request);
    ipcRenderer.on(IPC.serverRequest, handler);
    return () => ipcRenderer.off(IPC.serverRequest, handler);
  },
  respond(id, result) {
    ipcRenderer.send(IPC.serverResponse, { id, result });
  },
};

contextBridge.exposeInMainWorld("aporisa", bridge);
