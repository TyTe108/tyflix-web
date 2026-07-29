// Bootstraps the Google Cast Application Framework (CAF) web sender SDK.
// Nothing else in web/src/cast does anything until this has run.
//
// main.tsx calls initCast() once at startup, outside React, so a StrictMode
// double-mount can't inject the script twice. Everything downstream
// (useCastState, useCastPlayer, subscribeSessionReady) waits on
// subscribeCastReady() instead of reading the SDK globals directly, because the
// script is async and those globals genuinely don't exist for the first moment
// of the page's life. This file configures CastContext and stops. No UI, no
// media load, no device picker.
//
// The load handshake is the part that trips people up. CAF ships as a script
// off Google's CDN rather than an npm package, and it announces itself by
// calling window.__onGCastApiAvailable(isAvailable, reason). That callback has
// to already be on window by the time the script finishes, which is why it's
// assigned below before the tag goes into the head. The types for all of it are
// hand-declared in cast-globals.d.ts, since there's no package to get them
// from.
//
// Idempotent for the page lifetime. Completely silent outside Chromium, where
// there's no window.chrome to begin with. Inside Chromium, every failure path
// warns once and gives up.

// loadCastFramework=1 is what asks gstatic for the cast.framework layer this
// directory is written against.
const CAST_SENDER_SRC =
  "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

// Module-level rather than React state: one script injection and one
// CastContext configuration per page, no matter how many components mount.
// `started` guards the injection, `configured` guards setOptions.
let started = false;
let configured = false;
const readyListeners = new Set<() => void>();

/**
 * Registers a callback for the moment CastContext is configured and safe to
 * touch.
 *
 * Every consumer in this directory subscribes through here rather than poking
 * at cast.framework itself, because a component can easily mount before the
 * gstatic script lands. useCastState, useCastPlayer and subscribeSessionReady
 * all do their real setup inside this callback. Subscribing after the SDK is
 * already up still works: the listener fires on a microtask instead of running
 * inline, so subscribing never calls you back synchronously.
 *
 * @returns the unsubscribe function. Call it in effect cleanup, or a listener
 * closing over an unmounted component sits in the set for the page's lifetime.
 */
export function subscribeCastReady(listener: () => void): () => void {
  readyListeners.add(listener);
  if (configured && window.cast?.framework) {
    queueMicrotask(() => {
      if (readyListeners.has(listener)) {
        listener();
      }
    });
  }
  return () => {
    readyListeners.delete(listener);
  };
}

/**
 * Injects the CAF sender script and configures CastContext. Called once from
 * main.tsx; later calls return immediately.
 *
 * There's no success signal back to the caller, by design. Cast is optional, so
 * a browser that can't do it should carry on as if the feature weren't there.
 * Ask subscribeCastReady() whether the SDK actually came up.
 */
export function initCast(): void {
  if (started) {
    return;
  }
  started = true;

  // Framework already present (e.g. prior injection / hot reload race).
  // NOTE: this guard checks chrome.cast but not chrome.cast.media, while the
  // callback path below checks both. configureCastContext reads
  // chrome.cast.media, so a half-loaded SDK would throw out of initCast here.
  if (window.cast?.framework && typeof chrome !== "undefined" && chrome.cast) {
    configureCastContext();
    return;
  }

  // The SDK's only way of telling us it's ready is this global. Install it
  // before appending the script, and chain to whatever was already there rather
  // than clobbering another handler.
  const previous = window.__onGCastApiAvailable;
  window.__onGCastApiAvailable = (isAvailable, reason) => {
    try {
      previous?.(isAvailable, reason);
    } catch {
      // Ignore errors from a prior handler we didn't install.
    }

    // Chromium says no: usually just a machine with Cast turned off. Worth one
    // line in the console there, worth nothing at all anywhere else.
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

  // Handler is in place, so it's safe to pull the script. Async because
  // nothing on the page blocks on Cast being available.
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
}

// The one place CastContext gets configured. Reached either straight from
// initCast (framework already loaded) or from the __onGCastApiAvailable
// callback, and it has to be safe both ways.
function configureCastContext(): void {
  if (configured) {
    return;
  }
  // NOTE: the flag flips before setOptions runs. If setOptions ever threw we'd
  // be stuck marked configured with no listener notified, and every later
  // subscriber would be told it's ready when it isn't. Hasn't happened, but
  // that's the thing to look at if the cast button renders and does nothing.
  configured = true;

  // Google's Default Media Receiver is the stock app every Chromecast already
  // runs, so there's no custom receiver to write, host, or register. It's also
  // the constraint behind the DASH decision in loadMediaOnCast: it wouldn't
  // play Plex's HLS. ORIGIN_SCOPED widens auto-join from the single tab that
  // started the session to any tab on this origin.
  cast.framework.CastContext.getInstance().setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });

  // Copy the set before iterating, since a listener is free to unsubscribe (or
  // subscribe) while it's being notified.
  for (const listener of [...readyListeners]) {
    listener();
  }
}

/** Chromium family exposes `window.chrome`; Firefox/Safari do not. */
function isChromiumFamily(): boolean {
  return typeof window.chrome === "object" && window.chrome !== null;
}
