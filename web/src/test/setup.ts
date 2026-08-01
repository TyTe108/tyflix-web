// Vitest setup: jsdom 29 does not define window.matchMedia at all
// (`typeof window.matchMedia === "undefined"`). useIsMobile throws without a
// stub, and the existing AppShell suite assumes a desktop viewport.
//
// Default is desktop (matches: false). Tests flip the viewport with
// setViewport("mobile" | "desktop"), which updates matches and notifies
// change listeners so hooks can react to a resize, not just the initial read.
import { afterEach, beforeEach } from "vitest";
import { MOBILE_MEDIA_QUERY } from "../hooks/useIsMobile";

type Viewport = "mobile" | "desktop";

type ChangeListener = (event: MediaQueryListEvent) => void;

let currentViewport: Viewport = "desktop";
const listeners = new Set<ChangeListener>();

function matchesForQuery(query: string): boolean {
  if (query !== MOBILE_MEDIA_QUERY) {
    return false;
  }
  return currentViewport === "mobile";
}

function installMatchMedia(): void {
  listeners.clear();
  currentViewport = "desktop";

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
  const event = {
    matches: viewport === "mobile",
    media: MOBILE_MEDIA_QUERY,
  } as MediaQueryListEvent;
  for (const listener of listeners) {
    listener(event);
  }
}

beforeEach(() => {
  installMatchMedia();
});

afterEach(() => {
  setViewport("desktop");
});
