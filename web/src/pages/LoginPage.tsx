// The sign-in screen, and one of only two routes you can reach without a
// session. Rendered at /login by App.tsx, outside ProtectedRoute and outside
// AppShell, so there's no sidebar here.
//
// Drives Plex's PIN flow in the browser: opens a popup, creates a PIN against
// plex.tv (so the PIN is born from the user's IP), navigates the popup to
// Plex's auth page, polls the PIN, then posts the authToken once to
// POST /api/auth/plex/complete. The server validates membership and sets the
// session cookie. It also reads the public config through
// useAccessRequestsEnabled to decide whether to offer the request-access link.
//
// The popup is why the app's Cross-Origin-Opener-Policy is loosened. This page
// keeps a handle on the window so it can close it the moment sign-in lands,
// and a strict COOP would sever that handle.

import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { completePlexLogin } from "../api/auth";
import { useAuth } from "../auth/AuthContext";
import { useAccessRequestsEnabled } from "../hooks/useAccessRequestsEnabled";
import {
  buildPlexAuthUrl,
  checkPlexPin,
  createPlexPin,
  getPlexClientId,
} from "../lib/plexOauth";

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
   * The Sign in button. Opens the Plex popup synchronously (to beat blockers),
   * creates a PIN in this browser, then polls until Plex attaches a token.
   *
   * Starts with stopPolling so a second click can't leave two intervals
   * racing each other.
   */
  async function beginLogin() {
    stopPolling();
    setPhase("waiting");
    setMessage(null);

    // Popup must open synchronously on the click stack or browsers block it.
    // about:blank first; we navigate to the real auth URL once the PIN exists.
    const popup = window.open(
      "about:blank",
      "plex-auth",
      "width=600,height=750,menubar=no,toolbar=no",
    );
    if (popup === null) {
      setPhase("error");
      setMessage(
        "Pop-up blocked. Allow pop-ups for this site and try signing in again.",
      );
      return;
    }
    popupRef.current = popup;

    let clientId: string;
    let pin: { id: number; code: string };
    try {
      clientId = getPlexClientId();
      pin = await createPlexPin(clientId);
    } catch (err) {
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      popupRef.current = null;
      setPhase("error");
      setMessage(
        err instanceof Error ? err.message : "Could not start Plex login.",
      );
      return;
    }

    try {
      popup.location.href = buildPlexAuthUrl(pin.code, clientId);
    } catch {
      // Cross-origin or closed already — polling still proceeds; timeout covers it.
    }

    const pinId = pin.id;

    // Poll the PIN every two seconds against plex.tv. When a token arrives we
    // hand it to completePlexLogin once; that call never throws, it returns a
    // discriminated result. On success the session cookie is already set
    // server-side, so refresh() just re-reads /api/auth/me.
    pollRef.current = window.setInterval(() => {
      void (async () => {
        let authToken: string | null;
        try {
          const pinStatus = await checkPlexPin(pinId, clientId);
          authToken = pinStatus.authToken;
        } catch (err) {
          stopPolling();
          if (popupRef.current && !popupRef.current.closed) {
            popupRef.current.close();
          }
          popupRef.current = null;
          setPhase("error");
          setMessage(
            err instanceof Error
              ? err.message
              : "Plex sign-in failed while checking the PIN.",
          );
          return;
        }

        if (authToken === null) {
          return;
        }

        // Token stays in this function scope only — never storage or globals.
        stopPolling();
        if (popupRef.current && !popupRef.current.closed) {
          popupRef.current.close();
        }
        popupRef.current = null;

        const result = await completePlexLogin(authToken);

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
        setMessage(
          result.kind === "error"
            ? result.message
            : "Unexpected response from Plex login.",
        );
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
