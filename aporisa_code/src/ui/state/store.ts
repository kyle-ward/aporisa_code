// UI state: a reducer over L3 notifications and request results. Pure, no DOM.
import type { ContextUsage, Item, Notification, ProjectInfo, ServerRequest, ThreadInfo, ThreadSettings, Turn } from "../../app-protocol/types.ts";

export interface ThreadState {
  info: ThreadInfo;
  settings: ThreadSettings | null;
  turns: Turn[];
  usage: ContextUsage | null;
  /** Turns are present (opened in this window). */
  opened: boolean;
}

export interface Warning {
  id: number;
  threadId: string | null;
  message: string;
}

export interface AppState {
  threads: Record<string, ThreadState>;
  projects: ProjectInfo[];
  currentId: string | null;
  /** A new chat being written: created on its first message (F4.5), in this project (null: none). */
  draft: { projectId: string | null } | null;
  approvals: ServerRequest[];
  warnings: Warning[];
}

export type Action =
  | { type: "threads/listed"; threads: ThreadInfo[] }
  | { type: "thread/opened"; thread: ThreadInfo; settings: ThreadSettings; turns: Turn[] }
  | { type: "thread/select"; id: string | null }
  | { type: "thread/deleted"; id: string }
  | { type: "projects/listed"; projects: ProjectInfo[] }
  | { type: "project/updated"; project: ProjectInfo }
  | { type: "project/removed"; id: string }
  | { type: "draft/open"; projectId: string | null }
  | { type: "notification"; notification: Notification }
  | { type: "approval/requested"; request: ServerRequest }
  | { type: "approval/answered"; id: number }
  | { type: "warning/add"; threadId: string | null; message: string }
  | { type: "warning/dismiss"; id: number };

export const initialState: AppState = { threads: {}, projects: [], currentId: null, draft: { projectId: null }, approvals: [], warnings: [] };

let warningIds = 1;

function upsertInfo(state: AppState, info: ThreadInfo): AppState {
  const existing = state.threads[info.id];
  return {
    ...state,
    threads: {
      ...state.threads,
      [info.id]: existing
        ? { ...existing, info: { ...info, title: info.title || existing.info.title } }
        : { info, settings: null, turns: [], usage: null, opened: false },
    },
  };
}

function updateThread(state: AppState, id: string, change: (thread: ThreadState) => ThreadState): AppState {
  const thread = state.threads[id];
  if (!thread) return state;
  return { ...state, threads: { ...state.threads, [id]: change(thread) } };
}

function updateTurn(thread: ThreadState, turnId: string, change: (turn: Turn) => Turn): ThreadState {
  return { ...thread, turns: thread.turns.map((turn) => (turn.id === turnId ? change(turn) : turn)) };
}

function putItem(turn: Turn, item: Item): Turn {
  const index = turn.items.findIndex((existing) => existing.id === item.id);
  if (index < 0) return { ...turn, items: [...turn.items, item] };
  const items = [...turn.items];
  items[index] = item;
  return { ...turn, items };
}

function applyNotification(state: AppState, notification: Notification): AppState {
  switch (notification.method) {
    case "thread/started": {
      const next = upsertInfo(state, notification.params.thread);
      return updateThread(next, notification.params.thread.id, (thread) => ({ ...thread, settings: notification.params.settings, opened: true }));
    }
    case "thread/updated":
      return upsertInfo(state, notification.params.thread);
    case "thread/settings":
      return updateThread(state, notification.params.threadId, (thread) => ({ ...thread, settings: notification.params.settings }));
    case "thread/contextUsage":
      return updateThread(state, notification.params.threadId, (thread) => ({ ...thread, usage: notification.params.usage }));
    case "turn/started":
      return updateThread(state, notification.params.threadId, (thread) => ({
        ...thread,
        info: { ...thread.info, running: notification.params.turn.status === "running" || thread.info.running, updatedAt: Date.now() },
        turns: [...thread.turns.filter((turn) => turn.id !== notification.params.turn.id), notification.params.turn],
      }));
    case "item/started":
    case "item/completed":
      return updateThread(state, notification.params.threadId, (thread) => updateTurn(thread, notification.params.turnId, (turn) => putItem(turn, notification.params.item)));
    case "item/delta":
      return updateThread(state, notification.params.threadId, (thread) =>
        updateTurn(thread, notification.params.turnId, (turn) => ({
          ...turn,
          items: turn.items.map((item) =>
            item.id === notification.params.itemId && (item.type === "agentMessage" || item.type === "reasoning") ? { ...item, text: item.text + notification.params.delta } : item,
          ),
        })),
      );
    case "turn/completed":
      return updateThread(state, notification.params.threadId, (thread) => ({
        ...thread,
        info: { ...thread.info, running: false, updatedAt: Date.now() },
        // The completed turn is authoritative; if it carries no items, keep the streamed ones.
        turns: thread.turns.some((turn) => turn.id === notification.params.turn.id)
          ? thread.turns.map((turn) =>
              turn.id === notification.params.turn.id
                ? { ...notification.params.turn, items: notification.params.turn.items.length > 0 ? notification.params.turn.items : turn.items }
                : turn,
            )
          : [...thread.turns, notification.params.turn],
      }));
    case "warning":
      return { ...state, warnings: [...state.warnings, { id: warningIds++, threadId: notification.params.threadId, message: notification.params.message }] };
    default:
      return state;
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "threads/listed": {
      let next = state;
      for (const info of action.threads) next = upsertInfo(next, info);
      return next;
    }
    case "thread/opened": {
      const next = upsertInfo(state, action.thread);
      return {
        ...updateThread(next, action.thread.id, (thread) => ({ ...thread, settings: action.settings, turns: action.turns, opened: true })),
        currentId: action.thread.id,
        draft: null,
      };
    }
    case "thread/select":
      return { ...state, currentId: action.id, draft: action.id === null ? state.draft : null };
    case "thread/deleted": {
      const threads = { ...state.threads };
      const deleted = threads[action.id];
      delete threads[action.id];
      const current = state.currentId === action.id;
      return {
        ...state,
        threads,
        approvals: state.approvals.filter((request) => request.params.threadId !== action.id),
        currentId: current ? null : state.currentId,
        draft: current ? { projectId: deleted?.info.projectId ?? null } : state.draft,
      };
    }
    case "projects/listed":
      return { ...state, projects: action.projects };
    case "project/updated":
      return {
        ...state,
        projects: state.projects.some((project) => project.id === action.project.id)
          ? state.projects.map((project) => (project.id === action.project.id ? action.project : project))
          : [...state.projects, action.project],
      };
    case "project/removed": {
      // Its chats move to the chats without a project (FD-27).
      const threads: Record<string, ThreadState> = {};
      for (const [id, thread] of Object.entries(state.threads)) threads[id] = thread.info.projectId === action.id ? { ...thread, info: { ...thread.info, projectId: null } } : thread;
      return {
        ...state,
        threads,
        projects: state.projects.filter((project) => project.id !== action.id),
        draft: state.draft?.projectId === action.id ? { projectId: null } : state.draft,
      };
    }
    case "draft/open":
      return { ...state, currentId: null, draft: { projectId: action.projectId } };
    case "notification":
      return applyNotification(state, action.notification);
    case "approval/requested":
      return { ...state, approvals: [...state.approvals, action.request] };
    case "approval/answered":
      return { ...state, approvals: state.approvals.filter((request) => request.id !== action.id) };
    case "warning/add":
      return { ...state, warnings: [...state.warnings, { id: warningIds++, threadId: action.threadId, message: action.message }] };
    case "warning/dismiss":
      return { ...state, warnings: state.warnings.filter((warning) => warning.id !== action.id) };
  }
}

/** Threads for the sidebar: most recently updated first. */
export function sortedThreads(state: AppState): ThreadState[] {
  return Object.values(state.threads).sort((a, b) => b.info.updatedAt - a.info.updatedAt);
}

export interface SidebarGroups {
  /** Projects with recent activity first; projects without chats by creation, newest first. */
  projects: { project: ProjectInfo; chats: ThreadState[] }[];
  /** Chats without a project. */
  chats: ThreadState[];
}

export function sidebarGroups(state: AppState): SidebarGroups {
  const sorted = sortedThreads(state);
  const known = new Set(state.projects.map((project) => project.id));
  const projects = state.projects.map((project) => ({ project, chats: sorted.filter((thread) => thread.info.projectId === project.id) }));
  const activity = (group: (typeof projects)[number]) => group.chats[0]?.info.updatedAt ?? Date.parse(group.project.createdAt);
  projects.sort((a, b) => activity(b) - activity(a));
  return { projects, chats: sorted.filter((thread) => thread.info.projectId === null || !known.has(thread.info.projectId)) };
}
