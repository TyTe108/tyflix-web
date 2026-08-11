// One reported problem with its comment thread, plus the buttons to comment on
// it or resolve it. Rendered at /issues/:id by App.tsx, inside ProtectedRoute
// and AppShell. MyIssuesPage and the admin issues table both link here, each
// passing router state so the back link can return to that list.
//
// Three calls, all through api/issues.ts and all Seerr underneath: GET
// /api/issues/:id to load, POST /api/issues/:id/comment, and POST
// /api/issues/:id/status. Both writes re-fetch the issue rather than patching
// local state, so what you see is always Seerr's version.
//
// Authorization is per-issue, not per-role. The server lets you act on an
// issue if you filed it or if you're an admin, which means a normal member can
// resolve their own report. canAct below mirrors that same rule for the UI.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  addIssueComment,
  fetchIssue,
  formatIssueDate,
  issueStatusBadgeClass,
  issueStatusLabel,
  issueTypeLabel,
  setIssueStatus,
  type IssueView,
} from "../api/issues";
import { useAuth } from "../auth/AuthContext";

// Drives which of the three mutually exclusive body states renders below.
type LoadStatus = "loading" | "ready" | "error";

// Known list destinations callers may put in Link state. Router state is
// user-controllable via history, so anything outside this set is ignored.
const BACK_FROM_ADMIN_ISSUES = "/admin?tab=issues";
const BACK_FROM_MY_ISSUES = "/issues";
const ALLOWED_BACK_FROM = new Set([
  BACK_FROM_ADMIN_ISSUES,
  BACK_FROM_MY_ISSUES,
]);

// Rejects anything that isn't a plain positive integer, so a junk URL segment
// renders "not found" without firing a request.
function parseIssueId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Resolves the back-link destination from router state.
 *
 * A bookmark, refresh, or pasted URL has no state, so "/issues" is the safe
 * default — a working link to a list the visitor can always reach. Unknown
 * `from` values fall back the same way because history state is untrusted.
 */
function resolveBackFrom(state: unknown): string {
  if (
    typeof state === "object" &&
    state !== null &&
    "from" in state &&
    typeof (state as { from?: unknown }).from === "string" &&
    ALLOWED_BACK_FROM.has((state as { from: string }).from)
  ) {
    return (state as { from: string }).from;
  }
  return BACK_FROM_MY_ISSUES;
}

function backLinkLabel(from: string): string {
  return from === BACK_FROM_ADMIN_ISSUES
    ? "← Back to Issues"
    : "← Back to My Issues";
}

/**
 * Detail view for one issue.
 *
 * The server answers 403 and 404 identically through fetchIssue, so a
 * forbidden issue and a nonexistent one land in the same error state on
 * purpose. Nothing here tells you which.
 */
export function IssueDetailPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = parseIssueId(rawId);
  const location = useLocation();
  const backFrom = resolveBackFrom(location.state);
  const { isAdmin, user } = useAuth();
  const [issue, setIssue] = useState<IssueView | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [comment, setComment] = useState("");
  // Which write is in flight, if any. One shared value rather than two
  // booleans, because both buttons disable together while either is running.
  const [action, setAction] = useState<"comment" | "status" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const retry = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  // Owns the initial load. Re-runs on route id change or retry. The writes
  // below refresh through refreshIssue instead of going through here, so a
  // comment doesn't blank the page back to the loading state.
  useEffect(() => {
    if (id === null) {
      setIssue(null);
      setStatus("error");
      setError("Issue not found or you don't have access");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchIssue(id)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setIssue(result);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setIssue(null);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load issue",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  // Mirror of the server's canAccessIssue check. Getting it wrong here only
  // shows or hides buttons; the real gate is on the route.
  const canAct =
    issue !== null &&
    (isAdmin || issue.createdBy.id === user?.seerrUserId);

  // Oldest comment first so the thread reads top to bottom. Seerr's ordering
  // isn't relied on. Comments posted in the same second tie on date, so id
  // breaks the tie and keeps the sort stable.
  const comments = useMemo(
    () =>
      issue === null
        ? []
        : [...issue.comments].sort((a, b) => {
            const byDate =
              new Date(a.createdAt).getTime() -
              new Date(b.createdAt).getTime();
            return Number.isNaN(byDate) || byDate === 0
              ? a.id - b.id
              : byDate;
          }),
    [issue],
  );

  // Re-reads the issue after a write. Deliberately doesn't touch `status`, so
  // the thread stays on screen while it refreshes. Any throw here is caught by
  // the caller and surfaced as an action error, not a page error.
  const refreshIssue = useCallback(async () => {
    if (id === null) {
      return;
    }
    setIssue(await fetchIssue(id));
  }, [id]);

  // Posts a comment, then reloads the thread and clears the box. The textarea
  // is only cleared on success, so a failed submit doesn't lose what was typed.
  const submitComment = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const message = comment.trim();
      if (id === null || message === "") {
        return;
      }
      setAction("comment");
      setActionError(null);
      try {
        await addIssueComment(id, message);
        await refreshIssue();
        setComment("");
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Failed to add comment",
        );
      } finally {
        setAction(null);
      }
    },
    [comment, id, refreshIssue],
  );

  // Flips open to resolved and back. One button, both directions, driven off
  // the issue's current status rather than a separate piece of state.
  const toggleStatus = useCallback(async () => {
    if (id === null || issue === null) {
      return;
    }
    setAction("status");
    setActionError(null);
    try {
      await setIssueStatus(
        id,
        issue.status === "open" ? "resolved" : "open",
      );
      await refreshIssue();
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : "Failed to update issue",
      );
    } finally {
      setAction(null);
    }
  }, [id, issue, refreshIssue]);

  return (
    <main className="page page-wide">
      <header className="row">
        <Link to={backFrom} className="back-link">
          {backLinkLabel(backFrom)}
        </Link>
        {isAdmin ? (
          <Link to="/admin?tab=issues" className="issue-detail-admin-link">
            Admin
          </Link>
        ) : null}
      </header>

      {status === "loading" ? (
        <p className="muted issue-detail-loading">Loading issue…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error issue-detail-error">
          <p className="error">{error ?? "Failed to load issue"}</p>
          {id !== null ? (
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Header: poster, type and status badges, the title linking back to the
          media page, and who filed it. Seerr doesn't always resolve a title
          for the media record, so that falls back to the raw TMDB id. */}
      {status === "ready" && issue !== null ? (
        <article className="issue-detail">
          <header className="issue-detail-header">
            {issue.media.posterUrl ? (
              <img
                className="issue-detail-poster"
                src={issue.media.posterUrl}
                alt=""
              />
            ) : null}
            <div className="issue-detail-heading">
              <p className="issue-detail-tags">
                <span className="stats-tag">
                  {issueTypeLabel(issue.issueType)}
                </span>
                <span className={issueStatusBadgeClass(issue.status)}>
                  {issueStatusLabel(issue.status)}
                </span>
              </p>
              <h1>
                <Link
                  to={`/media/${issue.media.mediaType}/${issue.media.tmdbId}`}
                  className="issue-detail-title-link"
                >
                  {issue.media.title ?? `TMDB #${issue.media.tmdbId}`}
                </Link>
              </h1>
              <p className="issue-detail-meta muted">
                Reported by {issue.createdBy.displayName} on{" "}
                {formatIssueDate(issue.createdAt)}
              </p>
            </div>
          </header>

          <section
            className="issue-comments"
            aria-labelledby="issue-comments-heading"
          >
            <h2 id="issue-comments-heading">Comments</h2>
            {comments.length === 0 ? (
              <p className="muted">No comments yet.</p>
            ) : (
              <ol className="issue-comment-list">
                {comments.map((item) => (
                  <li key={item.id}>
                    <p className="issue-comment-meta muted">
                      <strong>{item.user.displayName}</strong>
                      <span>{formatIssueDate(item.createdAt)}</span>
                    </p>
                    <p className="issue-comment-message">{item.message}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Action panel, hidden entirely for anyone who can't act. The
              "posts from the server account" note is honest rather than
              decorative: Tyflix talks to Seerr with an admin API key, and
              Seerr attributes comments to that key's owner instead of the
              acting user. Issue creation does carry a userId, so only
              comments are misattributed. */}
          {canAct ? (
            <section className="issue-actions" aria-label="Issue actions">
              <button
                type="button"
                className="btn secondary"
                disabled={action !== null}
                onClick={() => void toggleStatus()}
              >
                {action === "status"
                  ? "Updating…"
                  : issue.status === "open"
                    ? "Mark resolved"
                    : "Reopen"}
              </button>

              <form className="issue-comment-form" onSubmit={submitComment}>
                <label htmlFor="issue-comment">Add a comment</label>
                <textarea
                  id="issue-comment"
                  rows={4}
                  value={comment}
                  disabled={action !== null}
                  onChange={(event) => setComment(event.target.value)}
                />
                <p className="muted issue-comment-note">
                  Comments post from the server account
                </p>
                <button
                  type="submit"
                  className="btn"
                  disabled={action !== null || comment.trim() === ""}
                >
                  {action === "comment" ? "Submitting…" : "Submit"}
                </button>
              </form>

              {actionError ? (
                <p className="error issue-action-error">{actionError}</p>
              ) : null}
            </section>
          ) : null}
        </article>
      ) : null}
    </main>
  );
}
