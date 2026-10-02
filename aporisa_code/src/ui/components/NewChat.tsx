// A new chat (F4.5): pick a project (or none) and write the first message; the chat is
// created only when it is sent, so empty chats never appear in the list.
import { Check, ChevronDown, Folder, FolderPlus, X } from "lucide-react";
import { useState } from "react";
import { createProject, rememberProject } from "../actions.ts";
import { useUi } from "../context.tsx";
import { Composer, type ComposerMessage } from "./Composer.tsx";
import { Menu } from "./Overlay.tsx";

export function NewChat({ projectId }: { projectId: string | null }) {
  const ui = useUi();
  const { bridge, state, dispatch, t } = ui;
  const [picking, setPicking] = useState(false);
  const project = projectId === null ? null : (state.projects.find((entry) => entry.id === projectId) ?? null);

  const choose = (id: string | null) => {
    rememberProject(id);
    dispatch({ type: "draft/open", projectId: id });
  };

  const send = async (message: ComposerMessage) => {
    const opened = await bridge.request("thread/start", { projectId: project?.id ?? null });
    dispatch({ type: "thread/opened", ...opened });
    rememberProject(project?.id ?? null);
    await bridge.request("turn/start", { threadId: opened.thread.id, ...message });
  };

  const picker = (
    <div className="draft-bar">
      <div className="popover-anchor">
        <button type="button" className="chip" onClick={() => setPicking((value) => !value)}>
          <Folder size={14} />
          <span>{project?.name ?? t("noProject")}</span>
          <ChevronDown size={13} />
        </button>
        {picking && (
          <Menu
            className="menu-up"
            onClose={() => setPicking(false)}
            items={[
              ...state.projects.map((entry) => ({ label: entry.name, icon: <Folder size={14} />, checked: entry.id === project?.id, onSelect: () => choose(entry.id) })),
              ...(state.projects.length > 0 ? [null] : []),
              {
                label: t("newProject"),
                icon: <FolderPlus size={14} />,
                onSelect: () =>
                  void createProject(ui).then((created) => {
                    if (created) choose(created.id);
                  }),
              },
              { label: t("noProject"), icon: project === null ? <Check size={14} /> : <X size={14} />, onSelect: () => choose(null) },
            ]}
          />
        )}
      </div>
      <span className="draft-where" title={project?.main}>
        {project ? t("newChat.inProject", { path: project.main }) : t("newChat.noProject")}
      </span>
    </div>
  );

  return (
    <div className="new-chat">
      <div className="new-chat-hero">
        <h1>{t("newChatTitle")}</h1>
      </div>
      <Composer running={false} onSend={send} header={picker} autoFocus />
    </div>
  );
}
