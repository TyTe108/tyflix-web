// The cast button's brain: can this browser cast, are we connected right now,
// and one toggle that starts or stops a session.
//
// PlayerControls uses it to decide whether the cast button renders at all and
// how it looks. WatchPage watches the same hook, where `connected` is the flag
// that tears the local hls.js player down and hands the title to the TV
// instead, then later seeds the browser's resume position when it flips back to
// false. Both call the hook independently, which is fine: it's a thin
// subscription over the single shared CastContext, and initCast owns the
// lifecycle.
//
// This hook deals in connection state only. Whether the receiver is ready for
// media is a different state machine, handled in subscribeSessionReady, and
// playback control lives in useCastPlayer.

import { useEffect, useState } from "react";
import { subscribeCastReady } from "./initCast";

// What a cast button needs and nothing more.
export type CastControlState = {
  /** True when Cast is supported (Chromium + CAF framework ready). */
  available: boolean;
  /**
   * True only when CastState is CONNECTED, never speculative. CONNECTING
   * doesn't count, and it matters: WatchPage kills the local <video> the moment
   * this goes true.
   */
  connected: boolean;
  /** Start a session (device picker) or end the current one. */
  toggle: () => void;
};

// What every non-Chromium browser sees, forever.
const UNAVAILABLE: Omit<CastControlState, "toggle"> = {
  available: false,
  connected: false,
};

// Firefox and Safari have no window.chrome at all, so this is the cheap first
// gate before anything touches the SDK.
function isChromiumFamily(): boolean {
  return typeof window.chrome === "object" && window.chrome !== null;
}

// Pull the current state straight from CastContext. Called on mount and again
// on every CAST_STATE_CHANGED, since the SDK is the source of truth and this
// hook keeps no state of its own beyond the last read.
function readCastSnapshot(): Omit<CastControlState, "toggle"> {
  if (!isChromiumFamily() || !window.cast?.framework) {
    return UNAVAILABLE;
  }

  const raw = cast.framework.CastContext.getInstance().getCastState();
  return {
    available: true,
    connected: raw === cast.framework.CastState.CONNECTED,
  };
}

function isSessionCancel(errorCode: unknown): boolean {
  // CAF rejects requestSession with chrome.cast.ErrorCode.CANCEL ("cancel")
  // when the user dismisses the picker. That's a choice, not a failure, so it
  // shouldn't reach the console.
  return errorCode === "cancel";
}

/**
 * Subscribes to Cast connection state and returns it with a toggle.
 *
 * Safe to call from more than one component. Each caller gets its own listener
 * on the shared CastContext, and the hook is inert everywhere Cast can't run,
 * so callers can render off `available` instead of doing their own sniffing.
 */
export function useCastState(): CastControlState {
  const [snapshot, setSnapshot] = useState(readCastSnapshot);

  // Runs once per mount. The listener can't be attached inline because the SDK
  // may still be loading, so the real work waits behind subscribeCastReady and
  // `context` doubles as the "did we attach yet" flag.
  useEffect(() => {
    if (!isChromiumFamily()) {
      setSnapshot(UNAVAILABLE);
      return;
    }

    let context: cast.framework.CastContext | null = null;

    const onCastStateChanged = () => {
      setSnapshot(readCastSnapshot());
    };

    const attach = () => {
      if (context !== null || !window.cast?.framework) {
        return;
      }
      context = cast.framework.CastContext.getInstance();
      // Read once on attach as well as on every event. The initial useState
      // call almost certainly ran before the SDK existed, and a device that was
      // already there wouldn't fire an event to correct it.
      setSnapshot(readCastSnapshot());
      context.addEventListener(
        cast.framework.CastContextEventType.CAST_STATE_CHANGED,
        onCastStateChanged,
      );
    };

    const unsubscribeReady = subscribeCastReady(attach);

    return () => {
      unsubscribeReady();
      if (context !== null) {
        context.removeEventListener(
          cast.framework.CastContextEventType.CAST_STATE_CHANGED,
          onCastStateChanged,
        );
        context = null;
      }
    };
  }, []);

  // One button, both directions. Reads live state from the SDK rather than the
  // rendered snapshot so a stale render can't send the wrong command.
  const toggle = () => {
    if (!isChromiumFamily() || !window.cast?.framework) {
      return;
    }

    const context = cast.framework.CastContext.getInstance();
    const state = context.getCastState();

    // Already casting, so stop. true also stops the receiver instead of leaving
    // the TV playing on its own.
    if (state === cast.framework.CastState.CONNECTED) {
      context.endCurrentSession(true);
      return;
    }

    // Opens Chrome's device picker. Nothing to do on success: the state change
    // arrives through the listener above, and loading the actual media is
    // WatchPage's job once subscribeSessionReady says the receiver is up.
    void context.requestSession().then(
      () => {
        // Session established, CAST_STATE_CHANGED will flip connected.
      },
      (errorCode: unknown) => {
        if (isSessionCancel(errorCode)) {
          return;
        }
        console.warn("[cast] Failed to start Cast session.", errorCode);
      },
    );
  };

  return {
    available: snapshot.available,
    connected: snapshot.connected,
    toggle,
  };
}
