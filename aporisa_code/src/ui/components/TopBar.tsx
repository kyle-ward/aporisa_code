import { Archive, BookMarked, ChevronDown, FolderOpen, Gauge, Shield, ShieldOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ApprovalPolicy, SandboxMode, ThreadSettings } from "../../app-protocol/types.ts";
import type { ReasoningEffort } from "../../protocol/index.ts";
import { useUi } from "../context.tsx";
import { formatTokens } from "../i18n.ts";
import type { ThreadState } from "../state/store.ts";

const EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];
const SANDBOXES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const APPROVALS: ApprovalPolicy[] = ["untrusted", "on-request", "never"];

export function TopBar({ thread }: { thread: ThreadState }) {
  const { bridge, state, t, language, fail } = useUi();
  const project = thread.info.projectId === null ? null : (state.projects.find((entry) => entry.id === thread.info.projectId) ?? null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  const settings = thread.settings;
  const usage = thread.usage;
  const running = thread.info.running;

  useEffect(() => {
    if (!permissionsOpen) return;
    const close = (event: MouseEvent) => {
      if (popover.current && !popover.current.contains(event.target as Node)) setPermissionsOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [permissionsOpen]);

  const update = (change: Partial<ThreadSettings>) => {
    void bridge.request("thread/settings/update", { threadId: thread.info.id, settings: change }).catch((error: unknown) => fail(error, thread.info.id));
  };
  const compact = () => {
    void bridge.request("thread/compact", { threadId: thread.info.id }).catch((error: unknown) => fail(error, thread.info.id));
  };

  const ratio = usage ? Math.min(1, usage.tokens / usage.contextWindow) : 0;
  const unsandboxed = settings?.sandbox === "danger-full-access";

  return (
    <header className="topbar">
      <button type="button" className="folder" title={`${thread.info.cwd} — ${t("revealFolder")}`} onClick={() => void bridge.request("shell/reveal", { path: thread.info.cwd })}>
        <FolderOpen size={14} />
        <span>{project?.name ?? (thread.info.scratch ? t("noProject") : thread.info.cwd.slice(thread.info.cwd.lastIndexOf("/") + 1))}</span>
      </button>
      {project && project.references.length > 0 && (
        <span className="references-badge" title={t("referencesTitle", { paths: project.references.join(", ") })}>
          <BookMarked size={13} />
          {project.references.length}
        </span>
      )}
      <div className="topbar-spacer" />
      {settings && (
        <label className="select-chip" title={t("effort")}>
          <span>{t("effort")}</span>
          <select value={settings.effort} onChange={(event) => update({ effort: event.target.value as ReasoningEffort })}>
            {EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {t(`effort.${effort}`)}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </label>
      )}
      {settings && (
        <div className="popover-anchor" ref={popover}>
          <button type="button" className={`chip${unsandboxed ? " warning" : ""}`} onClick={() => setPermissionsOpen((open) => !open)}>
            {unsandboxed ? <ShieldOff size={14} /> : <Shield size={14} />}
            <span>{t(`sandbox.${settings.sandbox}`)}</span>
          </button>
          {permissionsOpen && (
            <div className="popover">
              <div className="popover-title">{t("permissions")}</div>
              <label className="field">
                <span>{t("sandbox")}</span>
                <select value={settings.sandbox} onChange={(event) => update({ sandbox: event.target.value as SandboxMode })}>
                  {SANDBOXES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`sandbox.${mode}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("approval")}</span>
                <select value={settings.approval} onChange={(event) => update({ approval: event.target.value as ApprovalPolicy })}>
                  {APPROVALS.map((policy) => (
                    <option key={policy} value={policy}>
                      {t(`approval.policy.${policy}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field toggle">
                <span>{t("network")}</span>
                <input type="checkbox" checked={settings.network} disabled={settings.sandbox === "danger-full-access"} onChange={(event) => update({ network: event.target.checked })} />
              </label>
              <p className="hint">{t("settingsApplyNext")}</p>
            </div>
          )}
        </div>
      )}
      {usage && (
        <div
          className="context-meter"
          title={t("contextTitle", { used: formatTokens(usage.tokens, language), window: formatTokens(usage.contextWindow, language), compactAt: formatTokens(usage.compactAt, language) })}
        >
          <Gauge size={14} />
          <div className="meter">
            <div className={`meter-fill${usage.tokens >= usage.compactAt ? " high" : ""}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
          <span>{formatTokens(usage.tokens, language)}</span>
        </div>
      )}
      <button type="button" className="icon-button" title={t("compact")} disabled={running} onClick={compact}>
        <Archive size={15} />
      </button>
    </header>
  );
}
