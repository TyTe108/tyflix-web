// Shared bottom sheet: scrim, Escape-to-close, focus into the panel on open,
// and focus back to the trigger on close. MobileNav's More menu is the first
// consumer; Library filters (and later Dropdown) reuse the same behaviour so
// the three sheets cannot drift apart.
//
// closingMs, when above 0, keeps the scrim and panel mounted for that many
// milliseconds after open becomes false. The closing sheet is aria-hidden and
// inert, so it leaves the accessibility tree and stops taking input at once.
// Callers that leave it off are unchanged, and the sheet unmounts immediately.
//
// Deliberately not included:
// - A focus trap. Tab can leave the sheet; Escape + returning focus to the
//   trigger is the accessibility bar this app has chosen for these overlays.
// - aria-modal. Removed in 36.1.1 for the same reason — without a trap,
//   claiming the rest of the page is inert would be a lie to assistive tech.
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Element that opened the sheet; receives focus again when it closes. */
  returnFocusRef: RefObject<HTMLElement | null>;
  /** Accessible name for the dialog panel. */
  "aria-label": string;
  children: ReactNode;
  scrimClassName?: string;
  sheetClassName?: string;
  /** Optional test id on the scrim (MobileNav's suite asserts on this). */
  scrimTestId?: string;
  /**
   * Milliseconds the sheet stays mounted after open becomes false, so a
   * close animation can play. While that window runs the sheet is
   * aria-hidden and inert. Omit it, or pass 0 or less, and the sheet
   * unmounts immediately.
   */
  closingMs?: number;
};

/**
 * Renders nothing while closed. While open: a full-viewport scrim and a
 * dialog panel. Scrim click and Escape both call onClose. When closingMs is
 * above 0, the sheet stays mounted for that long after open becomes false,
 * hidden from assistive tech and ignoring input, then unmounts.
 */
export function BottomSheet({
  open,
  onClose,
  returnFocusRef,
  "aria-label": ariaLabel,
  children,
  scrimClassName = "bottom-sheet-scrim",
  sheetClassName = "bottom-sheet",
  scrimTestId,
  closingMs,
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const stayMs = closingMs !== undefined && closingMs > 0 ? closingMs : 0;
  const [phase, setPhase] = useState<"open" | "closing" | "closed">(
    open ? "open" : "closed",
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    sheetRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  // Return focus to the trigger when open becomes false, including while a
  // closing window is still mounted.
  useEffect(() => {
    if (wasOpenRef.current && !open) {
      returnFocusRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (open) {
      setPhase("open");
      return;
    }
    if (stayMs === 0) {
      setPhase("closed");
      return;
    }
    setPhase((current) => (current === "closed" ? "closed" : "closing"));
  }, [open, stayMs]);

  useEffect(() => {
    if (open || phase !== "closing" || stayMs === 0) {
      return;
    }
    const id = window.setTimeout(() => {
      setPhase("closed");
    }, stayMs);
    return () => {
      window.clearTimeout(id);
    };
  }, [open, phase, stayMs]);

  if (!open && (stayMs === 0 || phase === "closed")) {
    return null;
  }

  const closing = !open;

  return (
    <div
      className={scrimClassName}
      data-testid={scrimTestId}
      data-state={closing ? "closing" : "open"}
      aria-hidden={closing ? true : undefined}
      inert={closing}
      onClick={closing ? undefined : onClose}
    >
      <div
        ref={sheetRef}
        className={sheetClassName}
        role="dialog"
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
