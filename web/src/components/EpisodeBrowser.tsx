// Episodes on a TV show's title page. A Season dropdown picks one season, and
// the default is the lowest numbered season, or Specials when that is the only
// season. Each episode is one tile, and the whole tile is the Play link.
// Layout is CSS: a horizontal snap rail in the desktop shell, a full-width
// stack on phones.
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
import { Link } from "react-router";
import { formatRuntime } from "../api/discover";
import { libraryImageUrl } from "../api/library";
import { fetchEpisodes, type Episode } from "../api/watch";
import { Dropdown } from "./Dropdown";
import { WatchProgress } from "./WatchProgress";

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
 * Seasons for the dropdown. Numbered seasons stay in ascending order and
 * season 0, when present, is placed last so it can be labelled Specials.
 */
function orderedSeasons(episodes: Episode[]): Array<[number, Episode[]]> {
  const grouped = groupBySeason(episodes);
  return [
    ...grouped.filter(([season]) => season !== 0),
    ...grouped.filter(([season]) => season === 0),
  ];
}

/**
 * The tile's title line. An empty title becomes "Episode N" so the tile still
 * names which episode it is.
 */
function episodeTitle(episode: Episode): string {
  if (episode.title === "") {
    return `Episode ${episode.episodeNumber}`;
  }
  return `${episode.episodeNumber}. ${episode.title}`;
}

/**
 * The muted line under the title. Joins whichever of the content rating, a
 * runtime of at least one minute, and a four-digit year are present. Returns
 * null when none of them are, so the tile renders no meta line.
 */
function episodeMeta(episode: Episode): string | null {
  const parts: string[] = [];
  if (episode.contentRating) {
    parts.push(episode.contentRating);
  }
  if (episode.durationMs !== null) {
    const minutes = Math.round(episode.durationMs / 60_000);
    if (minutes >= 1) {
      parts.push(formatRuntime(minutes));
    }
  }
  if (episode.airDate !== null && /^\d{4}/.test(episode.airDate)) {
    parts.push(episode.airDate.slice(0, 4));
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" · ");
}

/**
 * Episode tiles for one show, one season at a time, fetched on mount.
 *
 * The dropdown defaults to the lowest numbered season, or Specials when season
 * 0 is the only one. Choosing another season replaces the tiles. A new tmdbId
 * goes back to that show's default.
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
  // Null means the show's default. A picked season lasts until the show
  // changes, even when the next show has a season with the same number.
  const [pickedSeason, setPickedSeason] = useState<number | null>(null);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    setPickedSeason(null);
  }, [tmdbId]);

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

  const seasons = orderedSeasons(episodes);
  const defaultSeason = seasons[0]?.[0] ?? null;
  const selectedSeason =
    pickedSeason !== null &&
    seasons.some(([season]) => season === pickedSeason)
      ? pickedSeason
      : defaultSeason;
  const visible =
    selectedSeason === null
      ? []
      : (seasons.find(([season]) => season === selectedSeason)?.[1] ?? []);

  return (
    <section
      className="media-detail-seasons"
      aria-labelledby="episodes-heading"
    >
      <div className="episode-heading-row">
        <h2 id="episodes-heading">Episodes</h2>
        {status === "ready" && seasons.length > 0 && selectedSeason !== null ? (
          <Dropdown
            label="Season"
            value={String(selectedSeason)}
            options={seasons.map(([season]) => ({
              value: String(season),
              label: season === 0 ? "Specials" : `Season ${season}`,
            }))}
            onChange={(value) => {
              setPickedSeason(Number(value));
            }}
          />
        ) : null}
      </div>

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
      {status === "ready" && seasons.length === 0 ? (
        <p className="muted">No episodes available.</p>
      ) : null}

      {status === "ready" && visible.length > 0 ? (
        <div className="episode-rail" key={`${tmdbId}-${selectedSeason}`}>
          {visible.map((episode) => {
            const title = episodeTitle(episode);
            const meta = episodeMeta(episode);
            return (
              <Link
                key={episode.ratingKey}
                className="episode-tile"
                to={`/watch/episode/${episode.ratingKey}`}
                state={{ enterFullscreen: true }}
              >
                <div className="episode-thumb">
                  {episode.thumb ? (
                    // Two sizes from the image route. 640x360 covers the widest desktop tile
                    // (19.7rem in styles.css's clamp) at up to 2x. 1280x720 is for the phone
                    // stack: below 48rem (MOBILE_MEDIA_QUERY) tiles take the page's full width,
                    // so a phone at 2x or 3x usually needs more than 640 pixels across. sizes
                    // copies that layout, so a change to either needs sizes changed too.
                    <img
                      src={libraryImageUrl(episode.thumb, "640x360")}
                      srcSet={`${libraryImageUrl(episode.thumb, "640x360")} 640w, ${libraryImageUrl(episode.thumb, "1280x720")} 1280w`}
                      sizes="(max-width: 48rem) 100vw, 19.7rem"
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <div
                      className="media-poster-placeholder"
                      aria-hidden="true"
                    >
                      No image
                    </div>
                  )}
                  <div className="episode-thumb-shade" aria-hidden="true" />
                  <svg
                    className="episode-play"
                    viewBox="0 0 24 24"
                    width="24"
                    height="24"
                    aria-hidden="true"
                  >
                    <path d="M8 5v14l11-7z" fill="white" />
                  </svg>
                  <WatchProgress
                    viewOffset={episode.viewOffset}
                    viewCount={episode.viewCount}
                    runtime={null}
                    durationMs={episode.durationMs}
                  />
                </div>
                <p className="episode-tile-title">{title}</p>
                {meta !== null ? (
                  <p className="episode-tile-meta">{meta}</p>
                ) : null}
                {episode.summary ? (
                  <p className="episode-tile-summary">{episode.summary}</p>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
