// Requests that change projects and chats, shared by the sidebar, the new-chat view and the
// app menu. Each one updates the state from the result; failures go to the warning area.
import type { ProjectInfo } from "../app-protocol/types.ts";
import type { UiContext } from "./context.tsx";

const LAST_PROJECT = "aporisa.lastProject";

/** The project new chats start in, remembered per window (a convenience; may be missing). */
export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

export function rememberProject(projectId: string | null): void {
  try {
    if (projectId === null) localStorage.removeItem(LAST_PROJECT);
    else localStorage.setItem(LAST_PROJECT, projectId);
  } catch {
    // Not essential.
  }
}

export async function refreshThreads(ui: UiContext): Promise<void> {
  const { threads } = await ui.bridge.request("thread/list", {});
  ui.dispatch({ type: "threads/listed", threads });
}

/** Picks a folder and makes it a project (or finds the project that has it). */
export async function createProject(ui: UiContext): Promise<ProjectInfo | null> {
  try {
    const { path } = await ui.bridge.request("dialog/selectFolder", {});
    if (!path) return null;
    const { project } = await ui.bridge.request("project/create", { main: path });
    ui.dispatch({ type: "project/updated", project });
    // Chats recorded before projects may now belong to it.
    await refreshThreads(ui);
    return project;
  } catch (error) {
    ui.fail(error);
    return null;
  }
}

export async function updateProject(ui: UiContext, projectId: string, change: { name?: string; references?: string[] }): Promise<void> {
  try {
    const { project } = await ui.bridge.request("project/update", { projectId, ...change });
    ui.dispatch({ type: "project/updated", project });
  } catch (error) {
    ui.fail(error);
  }
}

export async function removeProject(ui: UiContext, projectId: string): Promise<void> {
  try {
    await ui.bridge.request("project/remove", { projectId });
    ui.dispatch({ type: "project/removed", id: projectId });
    if (lastProject() === projectId) rememberProject(null);
  } catch (error) {
    ui.fail(error);
  }
}

export async function deleteChat(ui: UiContext, threadId: string): Promise<void> {
  try {
    await ui.bridge.request("thread/delete", { threadId });
    ui.dispatch({ type: "thread/deleted", id: threadId });
  } catch (error) {
    ui.fail(error, threadId);
  }
}

export function openDraft(ui: UiContext, projectId?: string | null): void {
  const wanted = projectId === undefined ? lastProject() : projectId;
  const exists = wanted !== null && ui.state.projects.some((project) => project.id === wanted);
  ui.dispatch({ type: "draft/open", projectId: exists ? wanted : null });
}
