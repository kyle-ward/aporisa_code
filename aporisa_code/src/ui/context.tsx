// Shared UI context: the bridge, state, dispatch and the translator.
import { createContext, useContext, type Dispatch } from "react";
import type { AporisaBridge, Language } from "../app-protocol/types.ts";
import type { Translate } from "./i18n.ts";
import type { Action, AppState } from "./state/store.ts";

export interface UiContext {
  bridge: AporisaBridge;
  state: AppState;
  dispatch: Dispatch<Action>;
  t: Translate;
  language: Language;
  /** Reports a failed request in the warning area. */
  fail: (error: unknown, threadId?: string | null) => void;
}

export const Context = createContext<UiContext | null>(null);

export function useUi(): UiContext {
  const value = useContext(Context);
  if (!value) throw new Error("UI context is missing");
  return value;
}
