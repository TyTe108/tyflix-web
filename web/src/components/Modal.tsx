// Shared centred modal shell: scrim, Escape-to-close, focus into the close
// button on open, and focus back to the trigger on close. ManageMediaModal is
// the first consumer; other admin overlays can reuse it.
//
// Deliberately not included:
// - A focus trap. Tab can leave the dialog; Escape + returning focus to the
//   trigger is the accessibility bar this app has chosen for overlays
//   (BottomSheet documents the same decision). Matching that house standard
//   here rather than diverging in one component.
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  /** Visible title; also used as the dialog's accessible name. */
  title: string;
  /** Optional stable id for aria-labelledby. Generated when omitted. */
  titleId?: string;
  /** Element that opened the modal; receives focus again when it closes. */
  returnFocusRef: RefObject<HTMLElement | null>;
  children: ReactNode;
};

/**
 * Renders nothing while closed. While open: a full-viewport scrim and a
 * centred dialog panel. Scrim click and Escape both call onClose; clicks
 * inside the panel do not.
 */
export function Modal({
  open,
  onClose,
  title,
  titleId,
  returnFocusRef,
  children,
}: ModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const generatedId = useId();
  const labelledBy = titleId ?? generatedId;

  useEffect(() => {
    if (!open) {
      return;
    }

    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      returnFocusRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open, returnFocusRef]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-scrim" role="presentation" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={labelledBy} className="modal-title">
            {title}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn secondary modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            Close
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
