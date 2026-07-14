import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { checkPlexLogin, startPlexLogin } from "../api/auth";
import { useAuth } from "../auth/AuthContext";

const POLL_MS = 2000;
const TIMEOUT_MS = 150_000;

type LoginPhase = "idle" | "waiting" | "error" | "forbidden";

export function LoginPage() {
  const { status, refresh } = useAuth();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<LoginPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const timerRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);

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

    const popup = window.open(
      start.authUrl,
      "plex-auth",
      "width=600,height=750,menubar=no,toolbar=no",
    );
    popupRef.current = popup;

    const pinId = start.pinId;

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

      {(phase === "error" || phase === "forbidden") && message ? (
        <p className="error" role="alert">
          {message}
        </p>
      ) : null}
    </main>
  );
}
