import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchEpisodes, type Episode } from "../api/watch";

type LoadStatus = "loading" | "ready" | "error";

function groupBySeason(episodes: Episode[]): Array<[number, Episode[]]> {
  const map = new Map<number, Episode[]>();
  for (const episode of episodes) {
    const list = map.get(episode.seasonNumber);
    if (list) {
      list.push(episode);
    } else {
      map.set(episode.seasonNumber, [episode]);
    }
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

export function EpisodeBrowser({ tmdbId }: { tmdbId: number }) {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
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

    void fetchEpisodes(tmdbId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setEpisodes(result.episodes);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setEpisodes([]);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load episodes",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [tmdbId, reloadKey]);

  const seasons = groupBySeason(episodes);

  return (
    <section
      className="media-detail-seasons"
      aria-labelledby="seasons-heading"
    >
      <h2 id="seasons-heading">Seasons</h2>

      {status === "loading" ? (
        <p className="muted">Loading episodes…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load episodes"}</p>
          <button type="button" className="btn secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" ? (
        seasons.length === 0 ? (
          <p className="muted">No episodes available.</p>
        ) : (
          <div className="episode-browser">
            {seasons.map(([seasonNumber, seasonEpisodes]) => (
              <div key={seasonNumber} className="episode-season">
                <h3 className="episode-season-heading">
                  Season {seasonNumber}
                </h3>
                <ul className="media-season-list episode-list">
                  {seasonEpisodes.map((episode) => (
                    <li key={episode.ratingKey} className="episode-row">
                      <span className="episode-label">
                        E{episode.episodeNumber} · {episode.title}
                      </span>
                      <Link
                        className="btn"
                        to={`/watch/episode/${episode.ratingKey}`}
                      >
                        Play
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}
