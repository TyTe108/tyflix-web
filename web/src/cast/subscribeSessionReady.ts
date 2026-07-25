/**
 * Notify when a Cast session is ready to accept loadMedia — SESSION_STARTED
 * or SESSION_RESUMED. CAST_STATE_CHANGED=CONNECTED can fire earlier, before
 * the receiver app is accepting loads.
 */

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
  let context: cast.framework.CastContext | null = null;
  let attached = false;

  const onSessionStateChanged = (
    event: cast.framework.SessionStateEventData,
  ) => {
    if (isSessionLive(event.sessionState)) {
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
    if (isSessionLive(context.getSessionState())) {
      const session = context.getCurrentSession();
      queueMicrotask(() => {
        listener(session);
      });
    }
  };

  const unsubscribeReady = subscribeCastReady(attach);

  return () => {
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
