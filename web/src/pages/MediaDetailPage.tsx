import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchMovie,
  fetchTv,
  formatRuntime,
  canRequest,
  mediaStatusBadgeClass,
  type MovieDetail,
  type TvDetail,
} from "../api/discover";
import {
  createIssue,
  type IssueType,
} from "../api/issues";
import { createRequest, mediaStatusLabel } from "../api/requests";

type LoadStatus = "loading" | "ready" | "error";
type MediaDetail = MovieDetail | TvDetail;
type RequestUiState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "requested" }
  | { kind: "already" }
  | { kind: "error"; message: string };
type IssueUiState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "submitted" }
  | { kind: "error"; message: string };

function parseType(raw: string | undefined): "movie" | "tv" | null {
  if (raw === "movie" || raw === "tv") {
    return raw;
  }
  return null;
}

function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

export function MediaDetailPage() {
  const params = useParams<{ type: string; id: string }>();
  const mediaType = parseType(params.type);
  const id = parseId(params.id);

  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    if (mediaType === null || id === null) {
      setDetail(null);
      setStatus("error");
      setError("Invalid media link.");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);

    const load =
      mediaType === "movie" ? fetchMovie(id) : fetchTv(id);

    void load
      .then((data) => {
        if (cancelled) {
          return;
        }
        setDetail(data);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setDetail(null);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load media details",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [mediaType, id, reloadKey]);

  return (
    <main className="page page-wide">
      <header className="row">
        <Link to="/discover">← Back to Discover</Link>
      </header>

      {status === "loading" ? (
        <p className="muted">Loading…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load details"}</p>
          {mediaType !== null && id !== null ? (
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          ) : (
            <Link to="/discover">Back to Discover</Link>
          )}
        </div>
      ) : null}

      {status === "ready" && detail !== null ? (
        <DetailBody detail={detail} />
      ) : null}
    </main>
  );
}

function DetailBody({ detail }: { detail: MediaDetail }) {
  const heroUrl = detail.backdropUrl ?? detail.posterUrl;
  const yearLabel = detail.year !== null ? ` (${detail.year})` : "";

  return (
    <article className="media-detail">
      <div className="media-detail-hero">
        {heroUrl ? (
          <img src={heroUrl} alt="" className="media-detail-hero-img" />
        ) : (
          <div className="media-detail-hero-placeholder" aria-hidden="true">
            No image
          </div>
        )}
      </div>

      <div className="media-detail-meta">
        <p className="media-detail-tag-row">
          <span className="stats-tag">
            {detail.mediaType === "tv" ? "TV" : "Movie"}
          </span>
          {detail.status ? (
            <span className="muted media-detail-status">{detail.status}</span>
          ) : null}
          {detail.mediaStatus !== null ? (
            <span className={mediaStatusBadgeClass(detail.mediaStatus)}>
              {mediaStatusLabel(detail.mediaStatus)}
            </span>
          ) : null}
        </p>

        <h1>
          {detail.title}
          <span className="media-detail-year">{yearLabel}</span>
        </h1>

        {detail.genres.length > 0 ? (
          <p className="media-detail-genres muted">
            {detail.genres.join(" · ")}
          </p>
        ) : null}

        {detail.mediaType === "movie" && detail.runtime !== null ? (
          <p className="media-detail-runtime muted">
            {formatRuntime(detail.runtime)}
          </p>
        ) : null}

        {detail.overview ? (
          <p className="media-detail-overview">{detail.overview}</p>
        ) : (
          <p className="muted">No overview available.</p>
        )}

        <RequestControls detail={detail} />

        {detail.mediaStatus !== null ? (
          <ReportIssueControls detail={detail} />
        ) : null}

        {detail.mediaType === "tv" ? (
          <section
            className="media-detail-seasons"
            aria-labelledby="seasons-heading"
          >
            <h2 id="seasons-heading">Seasons</h2>
            {detail.seasons.length === 0 ? (
              <p className="muted">No seasons listed.</p>
            ) : (
              <ul className="media-season-list">
                {detail.seasons.map((season) => (
                  <li key={season.seasonNumber}>
                    <span className="media-season-name">{season.name}</span>
                    <span className="muted">
                      {season.episodeCount} episode
                      {season.episodeCount === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </article>
  );
}

function ReportIssueControls({ detail }: { detail: MediaDetail }) {
  const [expanded, setExpanded] = useState(false);
  const [issueType, setIssueType] = useState<IssueType>("video");
  const [message, setMessage] = useState("");
  const [issueState, setIssueState] = useState<IssueUiState>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIssueState({ kind: "submitting" });
    try {
      const result = await createIssue({
        tmdbId: detail.tmdbId,
        mediaType: detail.mediaType,
        issueType,
        message,
      });
      if (result.ok) {
        setIssueState({ kind: "submitted" });
      } else {
        setIssueState({
          kind: "error",
          message: "This title is not tracked in Seerr.",
        });
      }
    } catch (err: unknown) {
      setIssueState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to report issue",
      });
    }
  }

  return (
    <section className="issue-report" aria-labelledby="issue-report-heading">
      <h2 id="issue-report-heading">Report an issue</h2>
      {!expanded ? (
        <button
          type="button"
          className="btn secondary"
          onClick={() => setExpanded(true)}
        >
          Report an issue
        </button>
      ) : issueState.kind === "submitted" ? (
        <p className="issue-report-success">Issue reported — thanks</p>
      ) : (
        <form
          className="issue-report-form"
          onSubmit={(event) => void submit(event)}
        >
          <label>
            <span>Issue type</span>
            <select
              value={issueType}
              onChange={(event) =>
                setIssueType(event.target.value as IssueType)
              }
              disabled={issueState.kind === "submitting"}
            >
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="subtitles">Subtitles</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            <span>What’s wrong?</span>
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              required
              rows={4}
              disabled={issueState.kind === "submitting"}
            />
          </label>
          <button
            type="submit"
            className="btn"
            disabled={issueState.kind === "submitting"}
          >
            {issueState.kind === "submitting" ? "Reporting…" : "Submit report"}
          </button>
          {issueState.kind === "error" ? (
            <p className="error issue-report-error">{issueState.message}</p>
          ) : null}
        </form>
      )}
    </section>
  );
}

function RequestControls({ detail }: { detail: MediaDetail }) {
  const [requestState, setRequestState] = useState<RequestUiState>({
    kind: "idle",
  });
  const [selectedSeasons, setSelectedSeasons] = useState<number[]>([]);

  const done =
    requestState.kind === "requested" || requestState.kind === "already";
  const submitting = requestState.kind === "submitting";

  const submit = useCallback(
    async (seasons?: number[]) => {
      setRequestState({ kind: "submitting" });
      try {
        const result = await createRequest({
          tmdbId: detail.tmdbId,
          mediaType: detail.mediaType,
          ...(seasons !== undefined ? { seasons } : {}),
        });
        if (result.ok) {
          setRequestState({ kind: "requested" });
        } else {
          setRequestState({ kind: "already" });
        }
      } catch (err: unknown) {
        setRequestState({
          kind: "error",
          message:
            err instanceof Error ? err.message : "Failed to create request",
        });
      }
    },
    [detail.mediaType, detail.tmdbId],
  );

  function toggleSeason(seasonNumber: number) {
    setSelectedSeasons((prev) =>
      prev.includes(seasonNumber)
        ? prev.filter((n) => n !== seasonNumber)
        : [...prev, seasonNumber].sort((a, b) => a - b),
    );
  }

  if (!canRequest(detail.mediaStatus)) {
    const label = detail.mediaStatus === "available" ? "Available" : "Requested";
    return (
      <section className="request-controls" aria-label="Request status">
        <p className="request-controls-status">
          <span className={mediaStatusBadgeClass(detail.mediaStatus)}>
            {label}
          </span>
        </p>
      </section>
    );
  }

  const partialAvailabilityContext =
    detail.mediaStatus === "partially_available" ? (
      <p className="request-controls-status">
        Partially available — request more
      </p>
    ) : null;

  if (detail.mediaType === "movie") {
    return (
      <section className="request-controls" aria-label="Request movie">
        {partialAvailabilityContext}
        {done ? (
          <p className="request-controls-status">
            {requestState.kind === "already"
              ? "Already requested"
              : "Requested"}
          </p>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? "Requesting…" : "Request"}
          </button>
        )}
        {requestState.kind === "error" ? (
          <p className="error request-controls-error">{requestState.message}</p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="request-controls" aria-label="Request TV seasons">
      {partialAvailabilityContext}
      {detail.seasons.length === 0 ? (
        <p className="muted">No seasons available to request.</p>
      ) : done ? (
        <p className="request-controls-status">
          {requestState.kind === "already" ? "Already requested" : "Requested"}
        </p>
      ) : (
        <>
          <fieldset className="request-season-pick" disabled={submitting}>
            <legend>Select seasons to request</legend>
            <ul className="request-season-check-list">
              {detail.seasons.map((season) => (
                <li key={season.seasonNumber}>
                  <label className="request-season-check">
                    <input
                      type="checkbox"
                      checked={selectedSeasons.includes(season.seasonNumber)}
                      onChange={() => toggleSeason(season.seasonNumber)}
                    />
                    <span>
                      {season.name}
                      <span className="muted">
                        {" "}
                        ({season.episodeCount} ep
                        {season.episodeCount === 1 ? "" : "s"})
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <button
            type="button"
            className="btn"
            disabled={submitting || selectedSeasons.length === 0}
            onClick={() => void submit(selectedSeasons)}
          >
            {submitting ? "Requesting…" : "Request selected seasons"}
          </button>
        </>
      )}
      {requestState.kind === "error" ? (
        <p className="error request-controls-error">{requestState.message}</p>
      ) : null}
    </section>
  );
}
