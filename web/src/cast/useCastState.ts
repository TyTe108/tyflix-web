import { useEffect, useState } from "react";
import { subscribeCastReady } from "./initCast";

export type CastControlState = {
  /** True when Cast is supported (Chromium + CAF framework ready). */
  available: boolean;
  /** True only when CastState is CONNECTED — never speculative. */
  connected: boolean;
  /** Start a session (device picker) or end the current one. */
  toggle: () => void;
};

const UNAVAILABLE: Omit<CastControlState, "toggle"> = {
  available: false,
  connected: false,
};

function isChromiumFamily(): boolean {
  return typeof window.chrome === "object" && window.chrome !== null;
}

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
  // when the user dismisses the picker — not a real failure.
  return errorCode === "cancel";
}

export function useCastState(): CastControlState {
  const [snapshot, setSnapshot] = useState(readCastSnapshot);

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

  const toggle = () => {
    if (!isChromiumFamily() || !window.cast?.framework) {
      return;
    }

    const context = cast.framework.CastContext.getInstance();
    const state = context.getCastState();

    if (state === cast.framework.CastState.CONNECTED) {
      context.endCurrentSession(true);
      return;
    }

    void context.requestSession().then(
      () => {
        // Session established — CAST_STATE_CHANGED will flip connected.
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
