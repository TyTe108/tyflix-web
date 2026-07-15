import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchMyRequests,
  formatRequestDate,
  mediaStatusLabel,
  requestStatusBadgeClass,
  type RequestView,
} from "../api/requests";
import { useAuth } from "../auth/AuthContext";

type LoadStatus = "loading" | "ready" | "error";

export function MyRequestsPage() {
  const { isAdmin, logout } = useAuth();
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchMyRequests()
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setRequests(rows);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setRequests([]);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load requests",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <main className="page page-wide">
      <header className="row">
        <h1>My Requests</h1>
        <div className="nav-links">
          <Link to="/">Home</Link>
          <Link to="/discover">Discover</Link>
          <Link to="/watchlist">Watchlist</Link>
          {isAdmin ? <Link to="/admin">Admin</Link> : null}
          <button
            type="button"
            className="btn secondary"
            onClick={() => void logout()}
          >
            Logout
          </button>
        </div>
      </header>

      <section aria-labelledby="my-requests-heading">
        <h2 id="my-requests-heading" className="visually-hidden">
          Request list
        </h2>

        {status === "loading" ? (
          <p className="muted">Loading your requests…</p>
        ) : null}

        {status === "error" ? (
          <div className="stats-error">
            <p className="error">{error ?? "Failed to load requests"}</p>
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}

        {status === "ready" && requests.length === 0 ? (
          <p className="muted">
            No requests yet.{" "}
            <Link to="/discover">Discover something</Link> to request.
          </p>
        ) : null}

        {status === "ready" && requests.length > 0 ? (
          <ul className="my-requests-list">
            {requests.map((row) => (
              <li key={row.id} className="my-requests-item">
                <div className="my-requests-row">
                  <Link
                    to={`/media/${row.mediaType}/${row.tmdbId}`}
                    className="my-requests-title"
                  >
                    {row.title}
                  </Link>
                  <span className="stats-tag">
                    {row.mediaType === "tv" ? "TV" : "Movie"}
                  </span>
                  <span className={requestStatusBadgeClass(row.requestStatus)}>
                    {row.requestStatus}
                  </span>
                </div>
                <div className="my-requests-meta muted">
                  <span>{mediaStatusLabel(row.mediaStatus)}</span>
                  {row.mediaType === "tv" &&
                  row.seasons &&
                  row.seasons.length > 0 ? (
                    <span>
                      Seasons {row.seasons.join(", ")}
                    </span>
                  ) : null}
                  <span>Requested {formatRequestDate(row.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
