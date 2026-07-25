/**
 * Load the Google Cast Application Framework (CAF) web sender SDK once and
 * configure CastContext for the Default Media Receiver. No UI, no media load.
 *
 * Idempotent for the page lifetime. No-ops cleanly where Cast is unsupported
 * (Firefox/Safari). Fail-loud (one warning) if Chromium reports the API
 * unavailable via __onGCastApiAvailable(false, …).
 */

import { castDiag } from "./castDiag";

const CAST_SENDER_SRC =
  "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

let started = false;
let configured = false;
const readyListeners = new Set<() => void>();

/**
 * Fires once the CAF framework is configured (or immediately if it already
 * is). Used by useCastState so the cast button can appear after async SDK load.
 */
export function subscribeCastReady(listener: () => void): () => void {
  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag(
    "subscribeCastReady",
    `subscribe (listeners=${readyListeners.size + 1}, configured=${configured})`,
  );
  readyListeners.add(listener);
  if (configured && window.cast?.framework) {
    queueMicrotask(() => {
      if (readyListeners.has(listener)) {
        // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
        castDiag(
          "subscribeCastReady",
          "fire (already-configured microtask)",
        );
        listener();
      }
    });
  }
  return () => {
    // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
    castDiag(
      "subscribeCastReady",
      `unsubscribe (listeners=${readyListeners.size - 1})`,
    );
    readyListeners.delete(listener);
  };
}

export function initCast(): void {
  if (started) {
    return;
  }
  started = true;

  // Framework already present (e.g. prior injection / hot reload race).
  if (window.cast?.framework && typeof chrome !== "undefined" && chrome.cast) {
    configureCastContext();
    return;
  }

  const previous = window.__onGCastApiAvailable;
  window.__onGCastApiAvailable = (isAvailable, reason) => {
    // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
    castDiag(
      "initCast",
      `__onGCastApiAvailable isAvailable=${isAvailable}`,
      reason ?? "",
    );

    try {
      previous?.(isAvailable, reason);
    } catch {
      // Ignore errors from a prior handler we didn't install.
    }

    if (!isAvailable) {
      if (isChromiumFamily()) {
        console.warn(
          "[cast] CAF sender SDK reported unavailable in this Chromium browser.",
          reason ?? "",
        );
      }
      return;
    }

    if (
      !window.cast?.framework ||
      typeof chrome === "undefined" ||
      !chrome.cast?.media
    ) {
      // Can happen if a dependent gstatic script was blocked (e.g. HTTP page
      // loading protocol-relative http://www.gstatic.com under an https-only CSP).
      if (isChromiumFamily()) {
        console.warn(
          "[cast] CAF reported available but framework globals are missing.",
          reason ?? "",
        );
      }
      return;
    }

    try {
      configureCastContext();
    } catch (err) {
      if (isChromiumFamily()) {
        console.warn("[cast] CastContext initialization failed.", err);
      }
    }
  };

  const script = document.createElement("script");
  script.src = CAST_SENDER_SRC;
  script.async = true;
  script.onerror = () => {
    if (isChromiumFamily()) {
      console.warn(
        "[cast] Failed to load CAF sender SDK from www.gstatic.com.",
      );
    }
  };
  document.head.appendChild(script);
  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag("initCast", "SDK script injected", CAST_SENDER_SRC);
}

function configureCastContext(): void {
  if (configured) {
    return;
  }
  configured = true;

  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag("initCast", "configureCastContext ran");

  cast.framework.CastContext.getInstance().setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });

  for (const listener of [...readyListeners]) {
    // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
    castDiag("subscribeCastReady", "fire (from configureCastContext)");
    listener();
  }
}

/** Chromium family exposes `window.chrome`; Firefox/Safari do not. */
function isChromiumFamily(): boolean {
  return typeof window.chrome === "object" && window.chrome !== null;
}
