// Previous and Next links under the player on an episode watch page.
//
// WatchPage renders this for episodes, under the player. It is presentational,
// with no fetching and no state, because WatchPage can't be rendered in the
// test suite (it needs hls.js, the router, and the descriptor fetch).
import { Link } from "react-router";
import type { NextEpisode, PreviousEpisode } from "../api/watch";

function episodeLabel(episode: {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
}): string {
  const position = `S${episode.seasonNumber}E${episode.episodeNumber}`;
  if (episode.title === "") {
    return position;
  }
  return `${position} · ${episode.title}`;
}

/**
 * Previous and Next links for one episode.
 *
 * Renders nothing when both neighbors are null. A previous link comes first,
 * then a next link. Neither link passes navigation state.
 */
export function EpisodeNav({
  previous,
  next,
}: {
  previous: PreviousEpisode | null;
  next: NextEpisode | null;
}) {
  if (previous === null && next === null) {
    return null;
  }

  return (
    <nav className="watch-episode-nav" aria-label="Episode navigation">
      {previous !== null ? (
        <Link
          className="watch-episode-nav-link watch-episode-nav-link--previous"
          to={`/watch/episode/${previous.ratingKey}`}
        >
          <span className="watch-episode-nav-direction">← Previous episode</span>
          <span className="watch-episode-nav-title">
            {episodeLabel(previous)}
          </span>
        </Link>
      ) : null}
      {next !== null ? (
        <Link
          className="watch-episode-nav-link watch-episode-nav-link--next"
          to={`/watch/episode/${next.ratingKey}`}
        >
          <span className="watch-episode-nav-direction">Next episode →</span>
          <span className="watch-episode-nav-title">{episodeLabel(next)}</span>
        </Link>
      ) : null}
    </nav>
  );
}
