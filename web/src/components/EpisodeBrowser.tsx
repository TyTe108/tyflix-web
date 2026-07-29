// The Seasons block on a TV show's detail page: every episode Plex actually
// holds, grouped by season, each with a Play link.
//
// MediaDetailPage renders this only for shows that resolved to something on the
// server. It's keyed on TMDB id, and the backend does the TMDB-to-Plex join, so
// what comes back is already Plex episodes with real ratingKeys. Play links go
// to /watch/episode/:ratingKey, never through TMDB again.
//
// Failure is contained here. A show that isn't on the server, or a lookup that
// falls over, shows an error with a Retry button and leaves the rest of the
// detail page alone.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchEpisodes, type Episode } from "../api/watch";

type LoadStatus = "loading" | "ready" | "error";

// Buckets a flat episode list into [seasonNumber, episodes] pairs in season
// order. The API returns one flat list, and episode order inside a season is
// left as the API gave it.
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

/**
 * Season-by-season episode list for one show, fetched on mount.
 *
 * @param tmdbId The show's TMDB id. The backend maps it to a Plex show and
 * returns that show's episodes, so a TMDB id with nothing behind it on the
 * server comes back as an error rather than an empty list.
 */
export function EpisodeBrowser({ tmdbId }: { tmdbId: number }) {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the fetch effect. Retry has no other input to change.
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  // Load the episode list. Fires on mount, on a switch to a different show, and
  // on Retry. The cancelled flag keeps a slow response from a previous show
  // out of the current one.
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

      {/* Ready. An empty list means the show is on the server but no episode
          files are, which reads differently from a failed lookup. */}
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
