import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchMyIssues,
  formatIssueDate,
  issueStatusBadgeClass,
  issueStatusLabel,
  issueTypeLabel,
  type IssueView,
} from "../api/issues";
import { useAuth } from "../auth/AuthContext";

type LoadStatus = "loading" | "ready" | "error";

export function MyIssuesPage() {
  const { isAdmin, logout } = useAuth();
  const [issues, setIssues] = useState<IssueView[]>([]);
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

    void fetchMyIssues()
      .then((results) => {
        if (cancelled) {
          return;
        }
        setIssues(results);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setIssues([]);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load issues",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <main className="page page-wide">
      <header className="row">
        <h1>My Issues</h1>
        <div className="nav-links">
          <Link to="/">Home</Link>
          <Link to="/discover">Discover</Link>
          <Link to="/watchlist">Watchlist</Link>
          <Link to="/requests">My Requests</Link>
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

      <section aria-labelledby="my-issues-heading">
        <h2 id="my-issues-heading" className="visually-hidden">
          Issue list
        </h2>

        {status === "loading" ? (
          <p className="muted">Loading your issues…</p>
        ) : null}

        {status === "error" ? (
          <div className="stats-error">
            <p className="error">{error ?? "Failed to load issues"}</p>
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}

        {status === "ready" && issues.length === 0 ? (
          <p className="muted">You haven't reported any issues.</p>
        ) : null}

        {status === "ready" && issues.length > 0 ? (
          <ul className="my-issues-list">
            {issues.map((issue) => (
              <li key={issue.id} className="my-issues-item">
                {issue.media.posterUrl ? (
                  <img
                    className="my-issues-poster"
                    src={issue.media.posterUrl}
                    alt=""
                    loading="lazy"
                  />
                ) : null}
                <div>
                  <div className="my-issues-row">
                    <Link
                      to={`/media/${issue.media.mediaType}/${issue.media.tmdbId}`}
                      className="my-issues-title"
                    >
                      {issue.media.title ?? `TMDB #${issue.media.tmdbId}`}
                    </Link>
                    <span className="stats-tag">
                      {issue.media.mediaType === "tv" ? "TV" : "Movie"}
                    </span>
                    <span>{issueTypeLabel(issue.issueType)}</span>
                    <span className={issueStatusBadgeClass(issue.status)}>
                      {issueStatusLabel(issue.status)}
                    </span>
                  </div>
                  <p className="my-issues-meta muted">
                    Reported {formatIssueDate(issue.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
