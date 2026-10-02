// Small overlay primitives: a modal dialog, a confirmation built on it, and a popover menu.
// Escape and a click outside close them.
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useUi } from "../context.tsx";

function useDismiss(onClose: () => void, ref?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: MouseEvent) => {
      if (ref?.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    if (ref) document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (ref) document.removeEventListener("mousedown", onDown);
    };
  }, [onClose, ref]);
}

export function Modal({ title, children, footer, onClose }: { title: string; children?: ReactNode; footer: ReactNode; onClose: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  useDismiss(onClose, card);
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={card}>
        <h2 className="modal-title">{title}</h2>
        {children && <div className="modal-body">{children}</div>}
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, body, confirm, onConfirm, onClose }: { title: string; body: string; confirm: string; onConfirm: () => void; onClose: () => void }) {
  const { t } = useUi();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className="primary destructive"
            autoFocus
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {confirm}
          </button>
        </>
      }
    >
      <p>{body}</p>
    </Modal>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

/** A popover list anchored by its parent (position: relative). `null` entries are separators. */
export function Menu({ items, onClose, className }: { items: (MenuItem | null)[]; onClose: () => void; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(onClose, box);
  return (
    <div className={`menu${className ? ` ${className}` : ""}`} role="menu" ref={box}>
      {items.map((item, index) =>
        item === null ? (
          <div key={index} className="menu-separator" />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? " danger" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            <span className="menu-label">{item.label}</span>
            {item.checked && <span className="menu-check">✓</span>}
          </button>
        ),
      )}
    </div>
  );
}
