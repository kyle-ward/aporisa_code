// The sidebar (F4.5): the product name, "New chat", projects with their chats, then chats
// without a project. Hovering a project offers a new chat in it and its menu; hovering a
// chat offers deleting it.
import { Ellipsis, Folder, FolderOpen, FolderPlus, Plus, Settings, SquarePen, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectInfo } from "../../app-protocol/types.ts";
import { createProject, deleteChat, openDraft, removeProject } from "../actions.ts";
import { useUi } from "../context.tsx";
import { formatAge } from "../i18n.ts";
import { sidebarGroups, type ThreadState } from "../state/store.ts";
import { ConfirmDialog, Menu } from "./Overlay.tsx";
import { ProjectDialog } from "./ProjectDialog.tsx";

function ChatRow({ thread, now, nested, onOpen }: { thread: ThreadState; now: number; nested: boolean; onOpen: (id: string) => void }) {
  const ui = useUi();
  const { state, t, language } = ui;
  const [confirming, setConfirming] = useState(false);
  const selected = state.currentId === thread.info.id;
  return (
    <div className={`chat-row${selected ? " selected" : ""}${nested ? " nested" : ""}`}>
      <button type="button" className="chat-open" title={thread.info.title || t("untitled")} onClick={() => onOpen(thread.info.id)}>
        {thread.info.running && <span className="running-dot" />}
        <span className="chat-title">{thread.info.title || t("untitled")}</span>
        <span className="chat-time">{formatAge(thread.info.updatedAt, now, language)}</span>
      </button>
      <button type="button" className="row-action" title={t("deleteChat")} aria-label={t("deleteChat")} onClick={() => setConfirming(true)}>
        <Trash2 size={14} />
      </button>
      {confirming && (
        <ConfirmDialog
          title={t("confirm.deleteChat.title")}
          body={t(thread.info.scratch ? "confirm.deleteChat.bodyScratch" : "confirm.deleteChat.body")}
          confirm={t("delete")}
          onConfirm={() => void deleteChat(ui, thread.info.id)}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function ProjectGroup({ project, chats, now, onOpen }: { project: ProjectInfo; chats: ThreadState[]; now: number; onOpen: (id: string) => void }) {
  const ui = useUi();
  const { state, t } = ui;
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<"settings" | "remove" | null>(null);
  const drafting = state.currentId === null && state.draft?.projectId === project.id;
  return (
    <div className="project-group">
      <div className={`project-row${drafting ? " selected" : ""}`}>
        <button type="button" className="project-open" title={project.main} onClick={() => setOpen((value) => !value)}>
          {open ? <FolderOpen size={15} /> : <Folder size={15} />}
          <span className="project-name">{project.name}</span>
        </button>
        <div className="row-actions">
          <button type="button" className="row-action" title={t("newChatIn", { name: project.name })} aria-label={t("newChatIn", { name: project.name })} onClick={() => openDraft(ui, project.id)}>
            <Plus size={14} />
          </button>
          <div className="popover-anchor">
            <button type="button" className={`row-action${menu ? " active" : ""}`} title={t("projectMenu")} aria-label={t("projectMenu")} onClick={() => setMenu((value) => !value)}>
              <Ellipsis size={14} />
            </button>
            {menu && (
              <Menu
                onClose={() => setMenu(false)}
                items={[
                  { label: t("projectSettings"), onSelect: () => setDialog("settings") },
                  null,
                  { label: t("removeProject"), danger: true, onSelect: () => setDialog("remove") },
                ]}
              />
            )}
          </div>
        </div>
      </div>
      {open && (
        <div className="project-chats">
          {chats.length === 0 ? <div className="sidebar-empty nested">{t("noChats")}</div> : chats.map((thread) => <ChatRow key={thread.info.id} thread={thread} now={now} nested onOpen={onOpen} />)}
        </div>
      )}
      {dialog === "settings" && <ProjectDialog project={project} onClose={() => setDialog(null)} />}
      {dialog === "remove" && (
        <ConfirmDialog
          title={t("confirm.removeProject.title", { name: project.name })}
          body={t("confirm.removeProject.body", { count: chats.length })}
          confirm={t("remove")}
          onConfirm={() => void removeProject(ui, project.id)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

export function Sidebar({ onOpenSettings, onOpenThread }: { onOpenSettings: () => void; onOpenThread: () => void }) {
  const ui = useUi();
  const { bridge, state, dispatch, t, fail } = ui;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const open = async (id: string) => {
    onOpenThread();
    const thread = state.threads[id];
    if (thread?.opened) {
      dispatch({ type: "thread/select", id });
      return;
    }
    try {
      const opened = await bridge.request("thread/resume", { threadId: id });
      dispatch({ type: "thread/opened", ...opened });
    } catch (error) {
      fail(error, id);
    }
  };

  const groups = sidebarGroups(state);
  const draftWithoutProject = state.currentId === null && state.draft !== null && state.draft.projectId === null;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">{t("appName")}</div>
        <button
          type="button"
          className={`sidebar-action${draftWithoutProject ? " selected" : ""}`}
          onClick={() => {
            onOpenThread();
            openDraft(ui);
          }}
        >
          <SquarePen size={16} />
          <span>{t("newThread")}</span>
        </button>
      </div>
      <nav className="sidebar-scroll">
        <div className="sidebar-section">
          <span>{t("projects")}</span>
          <button type="button" className="row-action visible" title={t("newProject")} aria-label={t("newProject")} onClick={() => void createProject(ui)}>
            <FolderPlus size={14} />
          </button>
        </div>
        {groups.projects.map(({ project, chats }) => (
          <ProjectGroup key={project.id} project={project} chats={chats} now={now} onOpen={(id) => void open(id)} />
        ))}
        <div className="sidebar-section">
          <span>{t("threads")}</span>
        </div>
        {groups.chats.length === 0 ? (
          <div className="sidebar-empty">{t("noChats")}</div>
        ) : (
          groups.chats.map((thread) => <ChatRow key={thread.info.id} thread={thread} now={now} nested={false} onOpen={(id) => void open(id)} />)
        )}
      </nav>
      <div className="sidebar-bottom">
        <button type="button" className="sidebar-action" onClick={onOpenSettings}>
          <Settings size={16} />
          <span>{t("settings")}</span>
        </button>
      </div>
    </aside>
  );
}
