// Project settings (F4.5): name, the main folder (fixed), and reference folders the agent
// may read but is told not to change (FD-25).
import { FolderOpen, X } from "lucide-react";
import { useState } from "react";
import type { ProjectInfo } from "../../app-protocol/types.ts";
import { updateProject } from "../actions.ts";
import { useUi } from "../context.tsx";
import { Modal } from "./Overlay.tsx";

export function ProjectDialog({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const ui = useUi();
  const { bridge, t, fail } = ui;
  const [name, setName] = useState(project.name);

  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed !== "" && trimmed !== project.name) void updateProject(ui, project.id, { name: trimmed });
  };

  const addReference = async () => {
    try {
      const { path } = await bridge.request("dialog/selectFolder", {});
      if (path) await updateProject(ui, project.id, { references: [...project.references, path] });
    } catch (error) {
      fail(error);
    }
  };

  return (
    <Modal
      title={t("projectSettings").replace(/…$/, "")}
      onClose={() => {
        saveName();
        onClose();
      }}
      footer={
        <button
          type="button"
          className="primary"
          onClick={() => {
            saveName();
            onClose();
          }}
        >
          {t("done")}
        </button>
      }
    >
      <label className="field column">
        <span>{t("project.name")}</span>
        <input
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          onBlur={saveName}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) saveName();
          }}
        />
      </label>
      <div className="field column">
        <span>{t("project.main")}</span>
        <button type="button" className="folder-path" title={t("revealFolder")} onClick={() => void bridge.request("shell/reveal", { path: project.main })}>
          <FolderOpen size={14} />
          <span>{project.main}</span>
        </button>
        <span className="hint">{t("project.mainHint")}</span>
      </div>
      <div className="field column">
        <span>{t("project.references")}</span>
        {project.references.length === 0 && <span className="hint">{t("project.noReferences")}</span>}
        {project.references.map((path) => (
          <div key={path} className="reference-row">
            <button type="button" className="folder-path" title={t("revealFolder")} onClick={() => void bridge.request("shell/reveal", { path })}>
              <FolderOpen size={14} />
              <span>{path}</span>
            </button>
            <button
              type="button"
              className="icon-button small"
              title={t("remove")}
              onClick={() => void updateProject(ui, project.id, { references: project.references.filter((entry) => entry !== path) })}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <div>
          <button type="button" onClick={() => void addReference()}>
            {t("project.addReference")}
          </button>
        </div>
        <span className="hint">{t("project.referencesHint")}</span>
      </div>
    </Modal>
  );
}
