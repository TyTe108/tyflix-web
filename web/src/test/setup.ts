// Vitest setup: jsdom 29 does not define window.matchMedia at all
// (`typeof window.matchMedia === "undefined"`). useIsMobile / useIsTouch throw
// without a stub, and the existing AppShell suite assumes a desktop viewport.
//
// Default is desktop width (matches: false) and a fine pointer. Tests flip the
// axes with setViewport / setPointer, which update matches and notify change
// listeners so hooks can react — not just the initial read.
//
// jsdom 29 also has no ResizeObserver. EpisodeRail creates one on the episodes
// rail. The stub installed below does nothing: it never calls its callback.
// A test that needs the callback installs its own fake.
import { afterEach, beforeEach } from "vitest";
import { MOBILE_MEDIA_QUERY } from "../hooks/useIsMobile";
import { TOUCH_MEDIA_QUERY } from "../hooks/useIsTouch";

type Viewport = "mobile" | "desktop";
type Pointer = "coarse" | "fine";

type ChangeListener = (event: MediaQueryListEvent) => void;

let currentViewport: Viewport = "desktop";
let currentPointer: Pointer = "fine";
const listeners = new Set<ChangeListener>();

function matchesForQuery(query: string): boolean {
  if (query === MOBILE_MEDIA_QUERY) {
    return currentViewport === "mobile";
  }
  if (query === TOUCH_MEDIA_QUERY) {
    return currentPointer === "coarse";
  }
  return false;
}

function notifyListeners(query: string, matches: boolean): void {
  const event = { matches, media: query } as MediaQueryListEvent;
  for (const listener of listeners) {
    listener(event);
  }
}

function installMatchMedia(): void {
  listeners.clear();
  currentViewport = "desktop";
  currentPointer = "fine";

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const mql: MediaQueryList = {
        get matches() {
          return matchesForQuery(query);
        },
        media: query,
        onchange: null,
        addEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          if (type !== "change") {
            return;
          }
          listeners.add(listener as ChangeListener);
        },
        removeEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          if (type !== "change") {
            return;
          }
          listeners.delete(listener as ChangeListener);
        },
        // Legacy API still present on MediaQueryList in TypeScript's DOM lib.
        addListener: (listener: ChangeListener) => {
          listeners.add(listener);
        },
        removeListener: (listener: ChangeListener) => {
          listeners.delete(listener);
        },
        dispatchEvent: () => false,
      };
      return mql;
    },
  });
}

/**
 * Flip the stubbed viewport and fire matchMedia "change" listeners.
 * "mobile" => matches true for MOBILE_MEDIA_QUERY; "desktop" => false.
 */
export function setViewport(viewport: Viewport): void {
  currentViewport = viewport;
  notifyListeners(MOBILE_MEDIA_QUERY, viewport === "mobile");
}

/**
 * Flip the stubbed primary-pointer and fire matchMedia "change" listeners.
 * "coarse" => matches true for TOUCH_MEDIA_QUERY; "fine" => false.
 */
export function setPointer(pointer: Pointer): void {
  currentPointer = pointer;
  notifyListeners(TOUCH_MEDIA_QUERY, pointer === "coarse");
}

// A ResizeObserver that records nothing and never calls its callback.
// EpisodeRail can mount in any suite. Tests that need resize callbacks
// replace this with their own fake.
function installResizeObserver(): void {
  if (typeof globalThis.ResizeObserver !== "undefined") {
    return;
  }
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      // The stub never calls the callback.
      void callback;
    }

    observe(): void {}

    unobserve(): void {}

    disconnect(): void {}
  };
}

beforeEach(() => {
  installMatchMedia();
  installResizeObserver();
});

afterEach(() => {
  setViewport("desktop");
  setPointer("fine");
});
