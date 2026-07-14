import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  fetchMovie,
  fetchTv,
  formatRuntime,
  type MovieDetail,
  type TvDetail,
} from "../api/discover";

type LoadStatus = "loading" | "ready" | "error";
type MediaDetail = MovieDetail | TvDetail;

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
