// Closing window for BottomSheet. The desktop menu drawer opts in with
// closingMs. More and Filters leave it off and unmount as soon as they close.
//
// Fake timers cover the window. Clicks, key presses, and timer advances run
// inside act so React applies the update before the assertion.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "./BottomSheet";

function SheetHarness({
  closingMs,
  onClose,
}: {
  closingMs?: number;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      <BottomSheet
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        returnFocusRef={triggerRef}
        aria-label="Example"
        scrimTestId="sheet-scrim"
        closingMs={closingMs}
      >
        <button type="button">Inside</button>
      </BottomSheet>
    </>
  );
}

function renderSheet(closingMs?: number) {
  const onClose = vi.fn();
  const view = render(<SheetHarness closingMs={closingMs} onClose={onClose} />);
  return { onClose, ...view };
}

function openSheet() {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Open sheet" }));
  });
}

function closeFromScrim() {
  act(() => {
    fireEvent.click(screen.getByTestId("sheet-scrim"));
  });
}

describe("BottomSheet closing window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("unmounts the scrim immediately when closingMs is omitted", () => {
    renderSheet();
    openSheet();
    closeFromScrim();
    expect(screen.queryByTestId("sheet-scrim")).toBeNull();
  });

  it("unmounts the scrim immediately when closingMs is 0", () => {
    renderSheet(0);
    openSheet();
    closeFromScrim();
    expect(screen.queryByTestId("sheet-scrim")).toBeNull();
  });

  it("stays mounted for closingMs, hidden from assistive tech, then unmounts", () => {
    renderSheet(200);
    openSheet();

    const scrim = screen.getByTestId("sheet-scrim");
    expect(scrim.getAttribute("data-state")).toBe("open");
    expect(scrim.getAttribute("aria-hidden")).toBeNull();

    closeFromScrim();
    expect(scrim.getAttribute("data-state")).toBe("closing");
    expect(scrim.getAttribute("aria-hidden")).toBe("true");
    expect(scrim.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Example" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open sheet" }),
    );

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(screen.getByTestId("sheet-scrim")).toBe(scrim);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId("sheet-scrim")).toBeNull();
  });

  it("ignores Escape and a scrim click during the closing window", () => {
    const { onClose } = renderSheet(200);
    openSheet();
    closeFromScrim();
    expect(onClose).toHaveBeenCalledTimes(1);

    const scrim = screen.getByTestId("sheet-scrim");
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    act(() => {
      fireEvent.click(scrim);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels the unmount and returns to open when opened again while closing", () => {
    renderSheet(200);
    openSheet();
    closeFromScrim();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    });

    const scrim = screen.getByTestId("sheet-scrim");
    expect(scrim.getAttribute("data-state")).toBe("open");
    expect(scrim.getAttribute("aria-hidden")).toBeNull();
    expect(scrim.hasAttribute("inert")).toBe(false);
    const dialog = screen.getByRole("dialog", { name: "Example" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId("sheet-scrim")).toBe(scrim);
    expect(scrim.getAttribute("data-state")).toBe("open");
  });

  it("does not update state after unmount during the closing window", () => {
    const { unmount } = renderSheet(200);
    openSheet();
    closeFromScrim();
    expect(screen.getByTestId("sheet-scrim").getAttribute("data-state")).toBe(
      "closing",
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      unmount();
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
