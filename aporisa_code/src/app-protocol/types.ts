// L3: the contract between the app's UI (renderer) and its main process
// (docs/app-protocol.md; DEVELOPMENT_PLAN.md 10.3, FD-15). Shaped after a small subset of
// codex's app-server v2: client requests, server notifications and server-initiated
// requests (approvals). Only structured data crosses it: the UI turns codes into sentences
// in the user's language (FD-19). Additive evolution only (FD-24).
import type { ReasoningEffort } from "../protocol/index.ts";

export const APP_PROTOCOL_VERSION = 1;

export type Language = "en" | "zh-CN";
export type Appearance = "system" | "light" | "dark";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type ApprovalDecision = "approved" | "approved_for_session" | "denied";

export interface ThreadSettings {
  effort: ReasoningEffort;
  sandbox: SandboxMode;
  approval: ApprovalPolicy;
  network: boolean;
}

export interface DeviceSettings {
  language: Language;
  appearance: Appearance;
}

export interface ConnectionView {
  /** null: the built-in default (the local backend). */
  baseUrl: string | null;
  effectiveBaseUrl: string;
  keyConfigured: boolean;
  /** The last four characters of the key, never the key itself (FD-16). */
  keyHint: string | null;
  /** Where the key in use comes from: the keychain, or aporisa_code/.env in development. */
  keySource: "keychain" | "env" | null;
}

/** Defaults for new threads (account-level preferences, FD-23); effort null = the model's default. */
export type NewThreadDefaults = Omit<ThreadSettings, "effort"> & { effort: ReasoningEffort | null };

export interface SettingsView {
  device: DeviceSettings;
  newThread: NewThreadDefaults;
  connection: ConnectionView;
}

export interface ModelView {
  id: string;
  contextWindow: number;
  efforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
  images: boolean;
}

/**
 * A project (F4.5): a name, one main folder (where its chats work and may write) and
 * reference folders the agent reads but should not change (FD-25). Account-level data.
 */
export interface ProjectInfo {
  id: string;
  name: string;
  main: string;
  references: string[];
  createdAt: string;
}

export interface ThreadInfo {
  id: string;
  title: string;
  cwd: string;
  /**
   * The project the chat belongs to; null for a chat without a project, which includes chats
   * whose project was removed (FD-27).
   */
  projectId: string | null;
  /** The chat works in its own private folder (no project, FD-28). */
  scratch: boolean;
  model: string;
  createdAt: string;
  /** ms since the epoch. */
  updatedAt: number;
  /** Loaded in the main process (resumed or started in this app session). */
  loaded: boolean;
  running: boolean;
}

// --- items -----------------------------------------------------------------------------

export type CommandAction =
  | { kind: "read"; path: string }
  | { kind: "search"; query: string | null; path: string | null }
  | { kind: "list"; path: string | null }
  | { kind: "run"; command: string };

export interface PlanItem {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface FileChange {
  path: string;
  kind: "add" | "update" | "delete";
  movePath?: string;
}

export type ItemStatus = "running" | "completed" | "failed" | "declined";

export type Item =
  | { type: "userMessage"; id: string; text: string; images: string[] }
  | { type: "agentMessage"; id: string; text: string; phase: "commentary" | "final_answer" | null; status: "running" | "completed" }
  | { type: "reasoning"; id: string; text: string; durationMs: number | null; status: "running" | "completed" }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      actions: CommandAction[];
      status: ItemStatus;
      exitCode: number | null;
      durationMs: number | null;
      /** null until known (declined or refused before running). */
      sandboxed: boolean | null;
      escalated: boolean;
      /** Display output (no model header), capped by the harness. */
      output: string;
      /** Set while the process keeps running after the call returned. */
      sessionId: number | null;
    }
  | { type: "stdinInteraction"; id: string; sessionId: number; chars: string; status: ItemStatus; exitCode: number | null; output: string }
  | { type: "fileChange"; id: string; changes: FileChange[]; patch: string; status: ItemStatus; message: string | null }
  | { type: "plan"; id: string; explanation: string | null; plan: PlanItem[] }
  | { type: "imageView"; id: string; path: string; status: ItemStatus }
  | { type: "toolCall"; id: string; name: string; status: ItemStatus; output: string }
  | { type: "compaction"; id: string; reason: "auto" | "manual"; status: "running" | "completed" | "failed"; tokensBefore: number; tokensAfter: number | null };

export type ItemType = Item["type"];

export type TurnStatus = "running" | "completed" | "interrupted" | "failed";

export interface Turn {
  id: string;
  /** ISO time. */
  startedAt: string;
  completedAt: string | null;
  status: TurnStatus;
  error: { code: string; message: string } | null;
  /** The answer was cut at the output limit. */
  truncated: boolean;
  items: Item[];
}

// --- approvals -------------------------------------------------------------------------

export type ApprovalRequest =
  | {
      kind: "command";
      command: string;
      cwd: string;
      reason: "escalation" | "dangerous" | "untrusted" | "sandbox_denied";
      sandboxed: boolean;
      justification?: string;
      rememberPrefixes: string[][] | null;
    }
  | { kind: "patch"; cwd: string; changes: FileChange[]; reason: "outside_workspace" | "untrusted"; paths: string[] };

// --- methods ---------------------------------------------------------------------------

export interface ClientMethods {
  initialize: { params: Record<string, never>; result: { protocolVersion: number; appVersion: string; dataDir: string; development: boolean } };
  "settings/read": { params: Record<string, never>; result: SettingsView };
  "settings/update": {
    params: {
      device?: Partial<DeviceSettings>;
      newThread?: Partial<NewThreadDefaults>;
      /** baseUrl null resets to the default; apiKey "" removes the stored key. */
      connection?: { baseUrl?: string | null; apiKey?: string };
    };
    result: SettingsView;
  };
  "connection/test": { params: Record<string, never>; result: { ok: true; models: string[] } | { ok: false; error: string } };
  "model/list": { params: Record<string, never>; result: { models: ModelView[] } };
  "project/list": { params: Record<string, never>; result: { projects: ProjectInfo[] } };
  /** Adds a project for a main folder (or returns the one that already has it). */
  "project/create": { params: { main: string }; result: { project: ProjectInfo } };
  /** References replace the list; open chats of the project are told at their next turn. */
  "project/update": { params: { projectId: string; name?: string; references?: string[] }; result: { project: ProjectInfo } };
  /** Removes the project entry; its chats move to the chats without a project (FD-27). */
  "project/remove": { params: { projectId: string }; result: Record<string, never> };
  "thread/list": { params: Record<string, never>; result: { threads: ThreadInfo[] } };
  /** projectId null: a chat without a project, working in its own private folder (FD-28). */
  "thread/start": { params: { projectId: string | null; settings?: Partial<ThreadSettings> }; result: { thread: ThreadInfo; settings: ThreadSettings; turns: Turn[] } };
  /** Stops the chat if it runs, then moves its record (and private folder) to the Trash (FD-26). */
  "thread/delete": { params: { threadId: string }; result: Record<string, never> };
  "thread/resume": { params: { threadId: string }; result: { thread: ThreadInfo; settings: ThreadSettings; turns: Turn[] } };
  "thread/settings/update": { params: { threadId: string; settings: Partial<ThreadSettings> }; result: { settings: ThreadSettings } };
  "thread/compact": { params: { threadId: string }; result: { compacted: boolean; error: string | null } };
  "turn/start": { params: { threadId: string; text: string; images: string[] }; result: Record<string, never> };
  "turn/interrupt": { params: { threadId: string }; result: Record<string, never> };
  "dialog/selectFolder": { params: Record<string, never>; result: { path: string | null } };
  "shell/reveal": { params: { path: string }; result: Record<string, never> };
}

export type ClientMethod = keyof ClientMethods;
export type ParamsOf<M extends ClientMethod> = ClientMethods[M]["params"];
export type ResultOf<M extends ClientMethod> = ClientMethods[M]["result"];

export interface ContextUsage {
  /** Tokens the next request will carry (last usage plus estimate). */
  tokens: number;
  contextWindow: number;
  /** Automatic compaction starts at this many tokens. */
  compactAt: number;
}

export type Notification =
  | { method: "thread/started"; params: { thread: ThreadInfo; settings: ThreadSettings } }
  | { method: "thread/updated"; params: { thread: ThreadInfo } }
  | { method: "thread/settings"; params: { threadId: string; settings: ThreadSettings } }
  | { method: "thread/contextUsage"; params: { threadId: string; usage: ContextUsage } }
  | { method: "turn/started"; params: { threadId: string; turn: Turn } }
  | { method: "item/started"; params: { threadId: string; turnId: string; item: Item } }
  | { method: "item/delta"; params: { threadId: string; turnId: string; itemId: string; kind: "text" | "reasoning"; delta: string } }
  | { method: "item/completed"; params: { threadId: string; turnId: string; item: Item } }
  | { method: "turn/completed"; params: { threadId: string; turn: Turn } }
  | { method: "warning"; params: { threadId: string | null; message: string } }
  /** A menu command for the UI (the app menu lives in the main process). */
  | { method: "app/command"; params: { command: "openSettings" | "newThread" } };

export type NotificationMethod = Notification["method"];

export interface ServerRequests {
  "approval/request": { params: { threadId: string; turnId: string; itemId: string; request: ApprovalRequest }; result: { decision: ApprovalDecision } };
}

export type ServerRequest = { id: number; method: "approval/request"; params: ServerRequests["approval/request"]["params"] };

/** Electron IPC channel names (renderer ↔ main through the preload bridge). */
export const IPC = {
  request: "aporisa:request",
  notification: "aporisa:notification",
  serverRequest: "aporisa:server-request",
  serverResponse: "aporisa:server-response",
} as const;

/** What the preload exposes as window.aporisa. */
export interface AporisaBridge {
  request<M extends ClientMethod>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
  onNotification(listener: (notification: Notification) => void): () => void;
  onServerRequest(listener: (request: ServerRequest) => void): () => void;
  respond(id: number, result: ServerRequests["approval/request"]["result"]): void;
}

/** Errors crossing the bridge carry a code the UI can translate. */
export interface AppErrorShape {
  code: "invalid_params" | "unknown_method" | "not_found" | "busy" | "connection" | "internal";
  message: string;
}
