// The message box (FD-21): Enter sends, Shift+Enter breaks the line, and Enter while an input
// method is composing (Chinese, Japanese…) only confirms the composition. Images (PNG, JPEG)
// can be pasted, dropped or attached.
import { ArrowUp, ImagePlus, Square, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { useUi } from "../context.tsx";
import { isSendKey } from "../keys.ts";

export interface ComposerMessage {
  text: string;
  images: string[];
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
const MAX_HEIGHT = 220;

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * `onSend` rejects when the message was not taken; the text and images then come back.
 * `header` sits above the box (the new-chat view puts its project picker there).
 */
export function Composer({ running, onSend, onStop, header, autoFocus }: { running: boolean; onSend: (message: ComposerMessage) => Promise<void>; onStop?: () => void; header?: ReactNode; autoFocus?: boolean }) {
  const { t, fail } = useUi();
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(MAX_HEIGHT, element.scrollHeight)}px`;
  }, [text]);

  const addFiles = async (files: Iterable<File>) => {
    const accepted = [...files].filter((file) => IMAGE_TYPES.has(file.type));
    if (accepted.length === 0) return;
    try {
      const urls = await Promise.all(accepted.map(readImage));
      setImages((current) => [...current, ...urls].slice(0, 16));
    } catch (error) {
      fail(error);
    }
  };

  const send = () => {
    if (running || (text.trim() === "" && images.length === 0)) return;
    const message = { text, images };
    setText("");
    setImages([]);
    onSend(message).catch((error: unknown) => {
      setText(message.text);
      setImages(message.images);
      fail(error);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSendKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) {
      event.preventDefault();
      send();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => IMAGE_TYPES.has(file.type));
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  };

  return (
    <div className="composer-wrap">
      {header}
      <div
        className={`composer${dragging ? " dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((image, index) => (
              <div key={index} className="composer-image">
                <img src={image} alt="" />
                <button type="button" title={t("removeImage")} onClick={() => setImages((current) => current.filter((_, position) => position !== index))}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          autoFocus={autoFocus}
          value={text}
          placeholder={t("composerPlaceholder")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-bar">
          <button type="button" className="icon-button" title={t("attachImage")} onClick={() => picker.current?.click()}>
            <ImagePlus size={16} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <span className="composer-hint">{t("composerHint")}</span>
          {running ? (
            <button type="button" className="send stop" title={t("stop")} onClick={onStop}>
              <Square size={13} />
            </button>
          ) : (
            <button type="button" className="send" title={t("send")} disabled={text.trim() === "" && images.length === 0} onClick={send}>
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
