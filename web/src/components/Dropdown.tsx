// Themed single-select, the app's replacement for the native <select>.
//
// Native selects render their popup with the operating system's own chrome,
// which can't be styled and looks wrong against a dark poster-forward UI. This
// rebuilds the control out of a button plus a listbox so it takes the app's
// theme. It's used everywhere a filter or sort control appears: the Library
// page, Discover, the shared RequestControls bar, and the request form on the
// media detail page.
//
// Keyboard and ARIA behaviour is hand-rolled to match what the native control
// gives you for free, so treat the roles and the arrow-key handling as load
// bearing rather than decoration.
import { useCallback, useEffect, useId, useRef, useState } from "react";

type DropdownOption = {
  value: string;
  label: string;
};

type DropdownProps = {
  /** Accessible name for the trigger and the listbox. Not rendered as text. */
  label: string;
  /** Controlled: whatever matches an option's value is the one shown. */
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** Supply one to point an external <label> at the trigger. Otherwise useId. */
  id?: string;
  disabled?: boolean;
};

/**
 * Renders a styled dropdown with the trigger button collapsed and a listbox
 * panel when open.
 *
 * There's no visible text label. Callers that want one wrap this in their own
 * markup and pass the same string as `label` for the accessible name.
 *
 * A `value` that matches nothing in `options` shows an empty trigger, which is
 * how "no selection yet" renders.
 */
export function Dropdown({
  label,
  value,
  options,
  onChange,
  id,
  disabled = false,
}: DropdownProps) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const listboxId = `${triggerId}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Per-option DOM nodes, kept only so the highlighted one can be scrolled into
  // view when arrow keys walk past the edge of the panel.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  // Keyboard cursor. Separate from `value`: moving the highlight doesn't commit
  // a choice, which is how the native control behaves too.
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? "";

  // Both closers return focus to the trigger. Without that, dismissing the panel
  // drops focus to the body and the next Tab starts over from the top of the page.
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const selectOption = useCallback(
    (optionValue: string) => {
      onChange(optionValue);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );

  // A control that goes disabled while its panel is open would leave the panel
  // stranded, so force it shut.
  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  // Opening puts the cursor on the current selection, or on the first option
  // when nothing matches.
  useEffect(() => {
    if (open) {
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }
  }, [open, selectedIndex]);

  // Close on a click anywhere outside. Only bound while open.
  useEffect(() => {
    if (!open) {
      return;
    }

    function handleMouseDown(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // Keep the keyboard cursor on screen in a long list, like the genre filter.
  useEffect(() => {
    if (open) {
      optionRefs.current[highlightedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, open]);

  // All keyboard handling lives on the trigger, because focus never leaves it.
  // The options are real buttons for the mouse, but they're never focused, so
  // arrow keys have to move a highlight rather than move focus. Closed, the
  // open keys open. Open, arrows wrap around the ends, Enter commits, Escape
  // backs out without changing anything.
  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) {
      return;
    }

    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlightedIndex((index) => (index + 1) % options.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlightedIndex(
          (index) => (index - 1 + options.length) % options.length,
        );
        break;
      case "Enter":
        event.preventDefault();
        if (options[highlightedIndex]) {
          selectOption(options[highlightedIndex].value);
        }
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
      default:
        break;
    }
  }

  return (
    // The container is the outside-click boundary, so anything that should not
    // dismiss the panel has to live inside it.
    <div className="dropdown" ref={containerRef}>
      {/* Trigger: shows the selected label plus the caret. */}
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        className={open ? "dropdown-trigger open" : "dropdown-trigger"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={label}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            setOpen((isOpen) => !isOpen);
          }
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="dropdown-trigger-label">{selectedLabel}</span>
        <svg
          className="dropdown-caret"
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* Options panel. Unmounted when closed, unlike the player's settings
          panel. Hover moves the keyboard highlight too, so the mouse and the
          arrow keys can't end up disagreeing about which row is live. */}
      {open && !disabled ? (
        <ul
          id={listboxId}
          role="listbox"
          className="dropdown-panel"
          aria-label={label}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isHighlighted = index === highlightedIndex;
            const optionClassName = [
              "dropdown-option",
              isSelected ? "selected" : "",
              isHighlighted ? "highlighted" : "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <li key={option.value || "__empty__"} role="presentation">
                <button
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={optionClassName}
                  onClick={() => selectOption(option.value)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span>{option.label}</span>
                  {isSelected ? (
                    <svg
                      className="dropdown-option-check"
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      aria-hidden="true"
                    >
                      <path
                        d="M3 8l3.5 3.5L13 5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
