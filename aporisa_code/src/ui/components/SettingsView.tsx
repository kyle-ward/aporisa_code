// Settings (FD-20): general (language, appearance), connection (address, key, test), new
// thread defaults (effort, sandbox, approvals, network), about. The key is write-only.
import { useEffect, useState } from "react";
import type { ApprovalPolicy, Appearance, Language, ParamsOf, SandboxMode, SettingsView as SettingsData } from "../../app-protocol/types.ts";
import type { ReasoningEffort } from "../../protocol/index.ts";
import { useUi } from "../context.tsx";

export function SettingsView({ settings, onChange, onClose }: { settings: SettingsData; onChange: (settings: SettingsData) => void; onClose: () => void }) {
  const { bridge, t, fail } = useUi();
  const [baseUrl, setBaseUrl] = useState(settings.connection.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [info, setInfo] = useState<{ appVersion: string; dataDir: string } | null>(null);

  useEffect(() => {
    void bridge.request("initialize", {}).then(setInfo, fail);
  }, [bridge, fail]);

  const update = (change: ParamsOf<"settings/update">) => {
    void bridge.request("settings/update", change).then(onChange, fail);
  };

  const runTest = () => {
    setTest(null);
    void bridge.request("connection/test", {}).then(
      (result) => setTest(result.ok ? { ok: true, text: t("settings.testOk", { models: result.models.join(", ") }) } : { ok: false, text: t("settings.testFailed", { error: result.error }) }),
      fail,
    );
  };

  const connection = settings.connection;
  const keyStatus = !connection.keyConfigured
    ? t("settings.apiKeyMissing")
    : connection.keySource === "env"
      ? t("settings.apiKeyFromEnv", { hint: connection.keyHint ?? "" })
      : t("settings.apiKeyConfigured", { hint: connection.keyHint ?? "" });

  return (
    <div className="settings">
      <div className="settings-header">
        <h1>{t("settings")}</h1>
        <button type="button" className="primary" onClick={onClose}>
          {t("settings.done")}
        </button>
      </div>

      <section className="settings-section">
        <h2>{t("settings.general")}</h2>
        <label className="field">
          <span>{t("settings.language")}</span>
          <select value={settings.device.language} onChange={(event) => update({ device: { language: event.target.value as Language } })}>
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
        <div className="field">
          <span>{t("settings.appearance")}</span>
          <div className="segmented">
            {(["system", "light", "dark"] as Appearance[]).map((appearance) => (
              <button key={appearance} type="button" className={settings.device.appearance === appearance ? "selected" : ""} onClick={() => update({ device: { appearance } })}>
                {t(`appearance.${appearance}`)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>{t("settings.connection")}</h2>
        <label className="field column">
          <span>{t("settings.baseUrl")}</span>
          <div className="inline">
            <input type="url" value={baseUrl} placeholder={connection.effectiveBaseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            <button type="button" disabled={baseUrl.trim() === "" || baseUrl === connection.baseUrl} onClick={() => update({ connection: { baseUrl: baseUrl.trim() } })}>
              {t("settings.save")}
            </button>
            <button
              type="button"
              disabled={connection.baseUrl === null}
              onClick={() => {
                setBaseUrl("");
                update({ connection: { baseUrl: null } });
              }}
            >
              {t("settings.reset")}
            </button>
          </div>
          <span className="hint">{t("settings.baseUrlDefault", { url: connection.effectiveBaseUrl })}</span>
        </label>
        <label className="field column">
          <span>{t("settings.apiKey")}</span>
          <div className="inline">
            <input type="password" value={apiKey} autoComplete="off" placeholder={t("settings.apiKeyPlaceholder")} onChange={(event) => setApiKey(event.target.value)} />
            <button
              type="button"
              disabled={apiKey.trim() === ""}
              onClick={() => {
                update({ connection: { apiKey: apiKey.trim() } });
                setApiKey("");
              }}
            >
              {t("settings.save")}
            </button>
            <button type="button" disabled={connection.keySource !== "keychain"} onClick={() => update({ connection: { apiKey: "" } })}>
              {t("settings.remove")}
            </button>
          </div>
          <span className="hint">{keyStatus}</span>
        </label>
        <div className="field">
          <button type="button" onClick={runTest}>
            {t("settings.test")}
          </button>
          {test && <span className={test.ok ? "test-ok" : "test-failed"}>{test.text}</span>}
        </div>
      </section>

      <section className="settings-section">
        <h2>{t("settings.newThread")}</h2>
        <p className="hint">{t("settings.newThreadHint")}</p>
        <label className="field">
          <span>{t("effort")}</span>
          <select
            value={settings.newThread.effort ?? "default"}
            onChange={(event) => update({ newThread: { effort: event.target.value === "default" ? null : (event.target.value as ReasoningEffort) } })}
          >
            <option value="default">{t("modelDefault")}</option>
            {(["none", "low", "medium", "high"] as ReasoningEffort[]).map((effort) => (
              <option key={effort} value={effort}>
                {t(`effort.${effort}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("sandbox")}</span>
          <select value={settings.newThread.sandbox} onChange={(event) => update({ newThread: { sandbox: event.target.value as SandboxMode } })}>
            {(["read-only", "workspace-write", "danger-full-access"] as SandboxMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {t(`sandbox.${mode}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("approval")}</span>
          <select value={settings.newThread.approval} onChange={(event) => update({ newThread: { approval: event.target.value as ApprovalPolicy } })}>
            {(["untrusted", "on-request", "never"] as ApprovalPolicy[]).map((policy) => (
              <option key={policy} value={policy}>
                {t(`approval.policy.${policy}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field toggle">
          <span>{t("network")}</span>
          <input type="checkbox" checked={settings.newThread.network} onChange={(event) => update({ newThread: { network: event.target.checked } })} />
        </label>
      </section>

      <section className="settings-section">
        <h2>{t("settings.about")}</h2>
        {info && (
          <>
            <p>{t("settings.version", { version: info.appVersion })}</p>
            <div className="field">
              <span>{t("settings.dataDir")}</span>
              <button type="button" className="link" onClick={() => void bridge.request("shell/reveal", { path: info.dataDir })}>
                {info.dataDir}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
