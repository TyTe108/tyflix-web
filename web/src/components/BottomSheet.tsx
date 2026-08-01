// Shared bottom sheet: scrim, Escape-to-close, focus into the panel on open,
// and focus back to the trigger on close. MobileNav's More menu is the first
// consumer; Library filters (and later Dropdown) reuse the same behaviour so
// the three sheets cannot drift apart.
//
// Deliberately not included:
// - A focus trap. Tab can leave the sheet; Escape + returning focus to the
//   trigger is the accessibility bar this app has chosen for these overlays.
// - aria-modal. Removed in 36.1.1 for the same reason — without a trap,
//   claiming the rest of the page is inert would be a lie to assistive tech.
import {
  useEffect,
  useRef,
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
};

/**
 * Renders nothing while closed. While open: a full-viewport scrim and a
 * dialog panel. Scrim click and Escape both call onClose.
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
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);

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

  // Return focus to the trigger after the sheet unmounts.
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
    <div
      className={scrimClassName}
      data-testid={scrimTestId}
      onClick={onClose}
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
