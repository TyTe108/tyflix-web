// Side arrows on the Episodes rail. jsdom reports no overflow and all-zero
// rects, so each test installs the 1440 px (or a fitting) measurement on the
// rail element. React sets the rail's class after appending its children and
// before useLayoutEffect, which is when the first measurement runs.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EpisodeRail } from "./EpisodeRail";

type RailNumbers = {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  paddingStart: number;
  paddingEnd: number;
  tileWidth: number;
  pitch: number;
};

const AT_1440: RailNumbers = {
  scrollLeft: 0,
  scrollWidth: 3452,
  clientWidth: 1440,
  paddingStart: 60,
  paddingEnd: 60,
  tileWidth: 315.2,
  pitch: 335.2,
};

const FITS: RailNumbers = {
  ...AT_1440,
  scrollWidth: 1440,
  clientWidth: 1440,
};

type FakeObserver = {
  callback: ResizeObserverCallback;
  disconnect: ReturnType<typeof vi.fn>;
};

const observers: FakeObserver[] = [];
const metricsRef: { current: RailNumbers } = { current: AT_1440 };
const scrollLeftRef: { current: number } = { current: 0 };
let railEl: HTMLElement | null = null;
const scrollTo = vi.fn();

let originalSetAttribute: typeof Element.prototype.setAttribute;

function rect(left: number, width: number): DOMRect {
  return {
    x: left,
    y: 0,
    width,
    height: 100,
    top: 0,
    left,
    right: left + width,
    bottom: 100,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

function stubChild(child: Element, index: number): void {
  child.getBoundingClientRect = () => {
    const metrics = metricsRef.current;
    return rect(index * metrics.pitch, metrics.tileWidth);
  };
}

function stubRail(rail: HTMLElement): void {
  railEl = rail;
  const metrics = metricsRef.current;
  scrollLeftRef.current = metrics.scrollLeft;
  Object.defineProperty(rail, "scrollLeft", {
    configurable: true,
    get: () => scrollLeftRef.current,
    set: (value: number) => {
      scrollLeftRef.current = value;
    },
  });
  Object.defineProperty(rail, "scrollWidth", {
    configurable: true,
    get: () => metricsRef.current.scrollWidth,
  });
  Object.defineProperty(rail, "clientWidth", {
    configurable: true,
    get: () => metricsRef.current.clientWidth,
  });
  rail.style.paddingLeft = `${metrics.paddingStart}px`;
  rail.style.paddingRight = `${metrics.paddingEnd}px`;
  rail.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  Array.from(rail.children).forEach((child, index) => {
    stubChild(child, index);
  });
}

function installSetAttributeHook(): void {
  originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttribute(
    name: string,
    value: string,
  ): void {
    originalSetAttribute.call(this, name, value);
    if (name === "class" && value === "episode-rail" && this instanceof HTMLElement) {
      stubRail(this);
    }
  };
}

class FakeResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
}

function setMetrics(next: RailNumbers): void {
  metricsRef.current = next;
  scrollLeftRef.current = next.scrollLeft;
  if (railEl !== null) {
    railEl.style.paddingLeft = `${next.paddingStart}px`;
    railEl.style.paddingRight = `${next.paddingEnd}px`;
  }
}

function fireScroll(left: number): void {
  scrollLeftRef.current = left;
  if (railEl === null) {
    throw new Error("rail was not measured");
  }
  act(() => {
    railEl?.dispatchEvent(new Event("scroll"));
  });
}

function fireResize(): void {
  const observer = observers[0];
  act(() => {
    observer.callback([], observer as unknown as ResizeObserver);
  });
}

function tenTiles() {
  return Array.from({ length: 10 }, (_, index) => (
    <a key={index} href="#">
      Episode {index + 1}
    </a>
  ));
}

function renderRail(): ReturnType<typeof render> {
  return render(<EpisodeRail>{tenTiles()}</EpisodeRail>);
}

describe("EpisodeRail", () => {
  beforeEach(() => {
    observers.length = 0;
    railEl = null;
    scrollTo.mockClear();
    metricsRef.current = AT_1440;
    scrollLeftRef.current = 0;
    globalThis.ResizeObserver =
      FakeResizeObserver as unknown as typeof ResizeObserver;
    installSetAttributeHook();
  });

  afterEach(() => {
    Element.prototype.setAttribute = originalSetAttribute;
    Reflect.deleteProperty(globalThis, "ResizeObserver");
    cleanup();
  });

  it("renders no arrows when the row fits", () => {
    setMetrics(FITS);
    renderRail();
    expect(screen.queryByRole("button", { name: "Previous episodes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next episodes" })).toBeNull();
  });

  it("shows only Next at the start of a 1440 px row", () => {
    const { container } = renderRail();
    const next = screen.getByRole("button", { name: "Next episodes" });
    expect(next.getAttribute("type")).toBe("button");
    expect(screen.queryByRole("button", { name: "Previous episodes" })).toBeNull();
    const prev = container.querySelector(".episode-rail-arrow--prev");
    expect(prev).toBeInstanceOf(HTMLElement);
    if (!(prev instanceof HTMLElement)) {
      return;
    }
    expect(prev.classList.contains("is-hidden")).toBe(true);
    expect(prev.tabIndex).toBe(-1);
  });

  it("scrolls one page forward from the start", () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Next episodes" }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const options = scrollTo.mock.calls[0]?.[0] as ScrollToOptions;
    expect(options.left).toBeCloseTo(1340.8);
    expect(options.behavior).toBe("smooth");
  });

  it("scrolls back to 0 from the first page stop", () => {
    renderRail();
    fireScroll(1340.8);
    expect(screen.getByRole("button", { name: "Previous episodes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next episodes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous episodes" }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const options = scrollTo.mock.calls[0]?.[0] as ScrollToOptions;
    expect(options.left).toBeCloseTo(0);
  });

  it("hides Next at the end and steps Previous back one page", () => {
    renderRail();
    fireScroll(2012);
    expect(screen.queryByRole("button", { name: "Next episodes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous episodes" }));
    const options = scrollTo.mock.calls[0]?.[0] as ScrollToOptions;
    expect(options.left).toBeCloseTo(1340.8);
  });

  it("moves focus from Next to Previous when Next hides", () => {
    renderRail();
    const next = screen.getByRole("button", { name: "Next episodes" });
    next.focus();
    fireScroll(2012);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Previous episodes" }),
    );
  });

  it("jumps when reduced motion is requested", () => {
    renderRail();
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const matches = query === "(prefers-reduced-motion: reduce)";
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    });
    fireEvent.click(screen.getByRole("button", { name: "Next episodes" }));
    const options = scrollTo.mock.calls[0]?.[0] as ScrollToOptions;
    expect(options.behavior).toBe("auto");
    matchMedia.mockRestore();
  });

  it("shows Next after a resize makes the row overflow", () => {
    setMetrics(FITS);
    renderRail();
    expect(screen.queryByRole("button", { name: "Next episodes" })).toBeNull();
    setMetrics(AT_1440);
    fireResize();
    expect(screen.getByRole("button", { name: "Next episodes" })).toBeTruthy();
  });

  it("disconnects the observer on unmount", () => {
    const { unmount } = renderRail();
    expect(observers).toHaveLength(1);
    unmount();
    expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("logs a rejected measurement and keeps the tiles", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setMetrics({ ...AT_1440, clientWidth: Number.NaN });
    const { container } = renderRail();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/^EpisodeRail: /);
    expect(String(error.mock.calls[0]?.[0])).toContain("clientWidth");
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelectorAll(".episode-rail > a")).toHaveLength(10);
    error.mockRestore();
  });
});
