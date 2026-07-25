/**
 * Notify when a Cast session is ready to accept loadMedia — SESSION_STARTED
 * or SESSION_RESUMED. CAST_STATE_CHANGED=CONNECTED can fire earlier, before
 * the receiver app is accepting loads.
 */

import { castDiag } from "./castDiag";
import { subscribeCastReady } from "./initCast";

export type SessionReadyListener = (
  session: cast.framework.CastSession | null,
) => void;

function isSessionLive(state: cast.framework.SessionState): boolean {
  const { SessionState } = cast.framework;
  return (
    state === SessionState.SESSION_STARTED ||
    state === SessionState.SESSION_RESUMED
  );
}

export function subscribeSessionReady(
  listener: SessionReadyListener,
): () => void {
  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag("subscribeSessionReady", "subscribe");

  let context: cast.framework.CastContext | null = null;
  let attached = false;

  const onSessionStateChanged = (
    event: cast.framework.SessionStateEventData,
  ) => {
    const live = isSessionLive(event.sessionState);
    // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
    castDiag(
      "subscribeSessionReady",
      `SESSION_STATE_CHANGED sessionState=${event.sessionState} invokeListener=${live} reason=${live ? "event-live" : "event-not-live"}`,
    );
    if (live) {
      listener(event.session);
    }
  };

  const attach = () => {
    if (attached || !window.cast?.framework) {
      return;
    }
    attached = true;
    context = cast.framework.CastContext.getInstance();
    context.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
      onSessionStateChanged,
    );

    // Already in a live session (auto-join after refresh / late subscribe).
    const currentState = context.getSessionState();
    if (isSessionLive(currentState)) {
      const session = context.getCurrentSession();
      // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
      castDiag(
        "subscribeSessionReady",
        `invokeListener=true reason=already-live-on-attach sessionState=${currentState}`,
      );
      queueMicrotask(() => {
        listener(session);
      });
    } else {
      // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
      castDiag(
        "subscribeSessionReady",
        `invokeListener=false reason=not-live-on-attach sessionState=${currentState}`,
      );
    }
  };

  const unsubscribeReady = subscribeCastReady(attach);

  return () => {
    // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
    castDiag("subscribeSessionReady", "unsubscribe");
    unsubscribeReady();
    if (context !== null) {
      context.removeEventListener(
        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        onSessionStateChanged,
      );
      context = null;
    }
  };
}
