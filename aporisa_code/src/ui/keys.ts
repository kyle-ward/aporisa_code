// Keyboard rules for the composer (FD-21). Pure, so it is tested without a DOM.

export interface SendKeyEvent {
  key: string;
  shiftKey: boolean;
  /** True while an input method (Chinese, Japanese…) is composing. */
  isComposing: boolean;
  /** 229 marks a key the IME consumed (Safari/Chromium report it on the confirming Enter). */
  keyCode: number;
}

/** True for the Enter that should send: not with Shift, not while an IME is composing. */
export function isSendKey(event: SendKeyEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
