// List of problems the signed-in user has reported on titles, like bad audio
// or the wrong cut. Rendered at /issues by App.tsx, inside ProtectedRoute and
// AppShell.
//
// One call, GET /api/issues through api/issues.ts, which the server answers
// out of Seerr. Reports get created from MediaDetailPage, and each row here
// links to /issues/:id where the thread and the resolve button live. Admins
// see everyone's issues on the admin page instead, off /api/issues/all.

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

// Drives which of the four mutually exclusive body states renders below.
type LoadStatus = "loading" | "ready" | "error";

/**
 * The user's own issue reports, open and resolved alike, in the order Seerr
 * hands them back.
 *
 * Nothing is editable here. Commenting and resolving happen on IssueDetailPage.
 */
export function MyIssuesPage() {
  const [issues, setIssues] = useState<IssueView[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Bumping reloadKey is the only way to re-run the fetch, since there's
  // nothing else in its dependency list.
  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  // Owns the issue list. Runs on mount and again on every retry. The cancelled
  // flag stops a slow response from writing state after the component is gone.
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
      <h1>My Issues</h1>

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

        {/* One row per report: poster, a link back to the title, the issue
            type and status badges, then the date and a link into the thread.
            Seerr doesn't always resolve a title for the media record, so the
            link text falls back to the raw TMDB id. */}
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
                    Reported {formatIssueDate(issue.createdAt)} ·{" "}
                    <Link to={`/issues/${issue.id}`}>View issue</Link>
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
