// The app shell: sidebar, current thread, settings; wires the bridge to the reducer.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AporisaBridge, SettingsView as SettingsData } from "../app-protocol/types.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { ThreadView } from "./components/ThreadView.tsx";
import { NewChat } from "./components/NewChat.tsx";
import { openDraft } from "./actions.ts";
import { Context, type UiContext } from "./context.tsx";
import { translator } from "./i18n.ts";
import { initialState, reducer } from "./state/store.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App({ bridge }: { bridge: AporisaBridge }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const language = settings?.device.language ?? "en";
  const t = useMemo(() => translator(language), [language]);

  const fail = useCallback((error: unknown, threadId: string | null = null) => {
    dispatch({ type: "warning/add", threadId, message: errorMessage(error) });
  }, []);

  const context: UiContext = { bridge, state, dispatch, t, language, fail };
  // The menu's "New chat" needs the latest projects; a ref avoids resubscribing on each change.
  const latest = useRef(context);
  latest.current = context;

  useEffect(() => {
    const offNotification = bridge.onNotification((notification) => {
      if (notification.method === "app/command") {
        if (notification.params.command === "openSettings") setSettingsOpen(true);
        else {
          setSettingsOpen(false);
          openDraft(latest.current);
        }
        return;
      }
      dispatch({ type: "notification", notification });
    });
    const offRequest = bridge.onServerRequest((request) => dispatch({ type: "approval/requested", request }));
    void bridge.request("settings/read", {}).then(setSettings, fail);
    void bridge.request("project/list", {}).then(({ projects }) => {
      dispatch({ type: "projects/listed", projects });
      openDraft({ ...latest.current, state: { ...latest.current.state, projects } });
    }, fail);
    void bridge.request("thread/list", {}).then(({ threads }) => dispatch({ type: "threads/listed", threads }), fail);
    return () => {
      offNotification();
      offRequest();
    };
  }, [bridge, fail]);

  // Appearance: "system" follows the OS through prefers-color-scheme in styles.css.
  useEffect(() => {
    const appearance = settings?.device.appearance ?? "system";
    if (appearance === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = appearance;
    document.documentElement.lang = language;
  }, [settings?.device.appearance, language]);

  const current = state.currentId ? state.threads[state.currentId] : undefined;

  return (
    <Context.Provider value={context}>
      <div className="app">
        <Sidebar onOpenSettings={() => setSettingsOpen(true)} onOpenThread={() => setSettingsOpen(false)} />
        <main className="main">
          {settingsOpen && settings ? (
            <SettingsView settings={settings} onChange={setSettings} onClose={() => setSettingsOpen(false)} />
          ) : current ? (
            <ThreadView key={current.info.id} thread={current} />
          ) : (
            <NewChat projectId={state.draft?.projectId ?? null} />
          )}
        </main>
        {state.warnings.length > 0 && (
          <div className="toasts">
            {state.warnings.slice(-3).map((warning) => (
              <button key={warning.id} type="button" className="toast" onClick={() => dispatch({ type: "warning/dismiss", id: warning.id })}>
                {warning.message}
              </button>
            ))}
          </div>
        )}
      </div>
    </Context.Provider>
  );
}
