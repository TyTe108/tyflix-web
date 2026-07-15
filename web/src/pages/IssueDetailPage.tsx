import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link, useParams } from "react-router-dom";
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

type LoadStatus = "loading" | "ready" | "error";

function parseIssueId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function IssueDetailPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = parseIssueId(rawId);
  const { isAdmin, user } = useAuth();
  const [issue, setIssue] = useState<IssueView | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [comment, setComment] = useState("");
  const [action, setAction] = useState<"comment" | "status" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const retry = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

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

  const canAct =
    issue !== null &&
    (isAdmin || issue.createdBy.id === user?.seerrUserId);

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

  const refreshIssue = useCallback(async () => {
    if (id === null) {
      return;
    }
    setIssue(await fetchIssue(id));
  }, [id]);

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
        <Link to="/issues">← Back to My Issues</Link>
        {isAdmin ? <Link to="/admin">Admin</Link> : null}
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
