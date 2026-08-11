// The sign-in screen, and one of only two routes you can reach without a
// session. Rendered at /login by App.tsx, outside ProtectedRoute and outside
// AppShell, so there's no sidebar here.
//
// Drives Plex's PIN flow through api/auth.ts: POST /api/auth/plex/start hands
// back a pinId and a plex.tv auth URL, that URL opens in a popup, and this
// page polls GET /api/auth/plex/check?pinId until Plex says the PIN was
// claimed. The server does the token exchange and sets the session cookie;
// the browser never sees a Plex token. It also reads the public config through
// useAccessRequestsEnabled to decide whether to offer the request-access link.
//
// The popup is why the app's Cross-Origin-Opener-Policy is loosened. This page
// keeps a handle on the window so it can close it the moment sign-in lands,
// and a strict COOP would sever that handle.

import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { checkPlexLogin, startPlexLogin } from "../api/auth";
import { useAuth } from "../auth/AuthContext";
import { useAccessRequestsEnabled } from "../hooks/useAccessRequestsEnabled";

const POLL_MS = 2000;
// Plex PINs are short-lived, so give up after two and a half minutes rather
// than polling forever behind a popup the user already abandoned.
const TIMEOUT_MS = 150_000;

// idle before the first attempt, waiting while the popup is open and polling,
// forbidden when Plex authenticated fine but the account has no Tyflix access.
type LoginPhase = "idle" | "waiting" | "error" | "forbidden";

/**
 * Plex PIN sign-in.
 *
 * Redirects to "/" as soon as AuthContext reports a session, which covers both
 * a successful login and someone who was already signed in hitting /login.
 */
export function LoginPage() {
  const { status, refresh } = useAuth();
  const navigate = useNavigate();
  const accessRequestsEnabled = useAccessRequestsEnabled();
  const [phase, setPhase] = useState<LoginPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const timerRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);

  // Unmount cleanup only. Navigating away mid-flow would otherwise leave the
  // interval running and an orphaned Plex popup on screen.
  useEffect(() => {
    return () => {
      stopPolling();
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    };
  }, []);

  if (status === "loading") {
    return <p className="muted">Loading…</p>;
  }

  if (status === "authed") {
    return <Navigate to="/" replace />;
  }

  // Tears down both timers together. Every exit from the waiting phase goes
  // through here, including the timeout firing on itself.
  function stopPolling() {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  /**
   * The Sign in button. Mints a PIN, opens Plex in a popup, then polls until
   * Plex reports it claimed.
   *
   * Starts with stopPolling so a second click can't leave two intervals
   * racing each other.
   */
  async function beginLogin() {
    stopPolling();
    setPhase("waiting");
    setMessage(null);

    let start;
    try {
      start = await startPlexLogin();
    } catch (err) {
      setPhase("error");
      setMessage(
        err instanceof Error ? err.message : "Could not start Plex login.",
      );
      return;
    }

    // Popup rather than a redirect, which is what keeps this page alive to do
    // the polling. A blocked popup isn't handled: the poll still runs and the
    // user just waits out the timeout.
    const popup = window.open(
      start.authUrl,
      "plex-auth",
      "width=600,height=750,menubar=no,toolbar=no",
    );
    popupRef.current = popup;

    // Captured out of `start` so the closure below doesn't hold the whole
    // response, and so a later beginLogin can't repoint it.
    const pinId = start.pinId;

    // Poll the PIN every two seconds. checkPlexLogin never throws, it returns
    // a discriminated result, so "pending" simply means keep waiting and the
    // other three kinds all end the flow. On success the session cookie is
    // already set server-side, so refresh() just re-reads /api/auth/me.
    pollRef.current = window.setInterval(() => {
      void (async () => {
        const result = await checkPlexLogin(pinId);
        if (result.kind === "pending") {
          return;
        }

        stopPolling();
        if (popupRef.current && !popupRef.current.closed) {
          popupRef.current.close();
        }
        popupRef.current = null;

        if (result.kind === "ok") {
          await refresh();
          navigate("/", { replace: true });
          return;
        }

        if (result.kind === "forbidden") {
          setPhase("forbidden");
          setMessage(result.message);
          return;
        }

        setPhase("error");
        setMessage(result.message);
      })();
    }, POLL_MS);

    // Hard stop. Fires only if the poll above never resolved, and its own
    // stopPolling call clears this timer too.
    timerRef.current = window.setTimeout(() => {
      stopPolling();
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      popupRef.current = null;
      setPhase("error");
      setMessage("Plex sign-in timed out. Please try again.");
    }, TIMEOUT_MS);
  }

  return (
    <main className="page login">
      <h1>Tyflix</h1>
      <p className="muted">Sign in with your Plex account to continue.</p>
      <p className="muted">
        Plex will show a &ldquo;Security Alert&rdquo; pop-up during sign-in.
        That&rsquo;s expected and not a problem with Tyflix. Just continue and
        sign in as normal.
      </p>

      {phase === "waiting" ? (
        <p>Waiting for approval…</p>
      ) : (
        <button type="button" className="btn" onClick={() => void beginLogin()}>
          Sign in with Plex
        </button>
      )}

      {/* Explicit === true because the hook returns null while the config
          probe is in flight, and a flash of a dead link is worse than a beat
          of nothing. Same check on the forbidden CTA below. */}
      {phase === "idle" && accessRequestsEnabled === true ? (
        <p className="muted login-request-link">
          <Link to="/request-access">Don&rsquo;t have access? Request it</Link>
        </p>
      ) : null}

      {/* "Forbidden" is the interesting failure: the Plex login worked, the
          account just isn't a member of this server. That's the one error
          worth pairing with a route into the access request form. Everything
          else collapses to a plain message. */}
      {phase === "forbidden" && message ? (
        <div className="login-forbidden" role="alert">
          <p className="error">{message}</p>
          {accessRequestsEnabled === true ? (
            <p className="login-forbidden-cta">
              <Link to="/request-access" className="btn">
                Request access
              </Link>
            </p>
          ) : null}
        </div>
      ) : phase === "error" && message ? (
        <p className="error" role="alert">
          {message}
        </p>
      ) : null}
    </main>
  );
}
