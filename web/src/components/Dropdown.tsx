import { useCallback, useEffect, useId, useRef, useState } from "react";

type DropdownOption = {
  value: string;
  label: string;
};

type DropdownProps = {
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
};

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
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? "";

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

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (open) {
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }
  }, [open, selectedIndex]);

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

  useEffect(() => {
    if (open) {
      optionRefs.current[highlightedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, open]);

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
    <div className="dropdown" ref={containerRef}>
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
