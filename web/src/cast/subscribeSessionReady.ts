// Fires a callback when a Cast session is genuinely ready to be handed media.
//
// WatchPage subscribes here and calls loadMediaOnCast from the callback. The
// obvious signal, CAST_STATE_CHANGED reaching CONNECTED, is the wrong one. It
// can arrive before the Default Media Receiver is willing to take a load, so
// this listens on SESSION_STATE_CHANGED instead and only reports the two states
// that mean the receiver app is up: SESSION_STARTED and SESSION_RESUMED.
//
// It also covers the case where a session is already live at subscribe time,
// which is what happens on a refresh into an existing cast or when the effect
// mounts late behind the SDK load. That path calls back on a microtask, so
// subscribing never invokes the listener synchronously.

import { subscribeCastReady } from "./initCast";

/**
 * Called once per ready session.
 *
 * The session argument can be null even on a live state, so don't dereference
 * it blindly. WatchPage only uses it as an identity for deduping repeat loads,
 * and loadMediaOnCast reads getCurrentSession() for itself.
 */
export type SessionReadyListener = (
  session: cast.framework.CastSession | null,
) => void;

// The two SessionStates that mean the receiver app is running and will accept
// a load. STARTED is a fresh session, RESUMED is auto-join picking one back up.
function isSessionLive(state: cast.framework.SessionState): boolean {
  const { SessionState } = cast.framework;
  return (
    state === SessionState.SESSION_STARTED ||
    state === SessionState.SESSION_RESUMED
  );
}

/**
 * Subscribes to session-ready transitions on the shared CastContext.
 *
 * Can be called before the SDK has loaded; setup is deferred through
 * subscribeCastReady. The listener may fire more than once in a page's life,
 * once per new or resumed session, so callers need to be idempotent about what
 * they do with it.
 *
 * @returns the unsubscribe function, which detaches both this listener and the
 * pending SDK-ready callback.
 */
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

  // Deferred until the SDK is up. Guarded so a second subscribeCastReady
  // callback can't double-register the listener.
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
    // The state transition happened before anyone was listening, so read it
    // once directly. The microtask keeps the callback out of the subscriber's
    // own setup, which would otherwise run before that setup finished.
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
