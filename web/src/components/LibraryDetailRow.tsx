// The wide row used by the Library page's detail view: poster on the left, then
// title, year, rating, runtime, genres and summary.
//
// It's the same data LibraryCard shows in grid mode, and it shares the same
// WatchProgress overlay, so progress bars and watched ticks read identically in
// either layout. LibraryPage is the only caller and picks between the two.
//
// A row isn't always a link. Plex items with no TMDB id and no direct play
// route (shows, mostly) render as plain text instead.
import { Link } from "react-router";
import { formatRuntime } from "../api/discover";
import {
  libraryImageUrl,
  libraryItemTarget,
  type LibraryItem,
} from "../api/library";
import { WatchProgress } from "./WatchProgress";

/**
 * One library item as a full-width row.
 *
 * `libraryItemTarget` decides where it goes: the TMDB detail page when the item
 * has a TMDB id, the ratingKey-native watch route for a movie without one, and
 * nowhere at all for a show with neither.
 */
export function LibraryDetailRow({ item }: { item: LibraryItem }) {
  const target = libraryItemTarget(item);
  const typeLabel = item.type === "show" ? "TV" : "Movie";
  const posterSrc = item.thumb ? libraryImageUrl(item.thumb) : null;

  // Year, rating, runtime and content rating, joined with dots. Built as a list
  // first so a missing field doesn't leave a stray separator behind.
  const metaParts: string[] = [];
  if (item.year !== null) {
    metaParts.push(String(item.year));
  }
  if (item.rating !== null) {
    metaParts.push(`★ ${item.rating.toFixed(1)}`);
  }
  if (item.runtime !== null) {
    metaParts.push(formatRuntime(item.runtime));
  }
  if (item.contentRating !== null) {
    metaParts.push(item.contentRating);
  }

  // Three genres is the cap. Plex will hand back plenty more.
  const genresLabel = item.genres.slice(0, 3).join(", ");
  const summary =
    item.summary !== null && item.summary.trim() !== "" ? item.summary : null;

  // Built once and rendered into either the link or the plain wrapper below,
  // so the two branches can't drift apart.
  const poster = (
    <>
      {posterSrc ? (
        <img src={posterSrc} alt="" loading="lazy" />
      ) : (
        <div className="media-poster-placeholder" aria-hidden="true">
          No poster
        </div>
      )}
      <WatchProgress
        viewOffset={item.viewOffset}
        viewCount={item.viewCount}
        runtime={item.runtime}
        durationMs={item.durationMs}
      />
    </>
  );

  return (
    <div className="library-detail-row">
      {/* Poster, linked or not depending on whether the item goes anywhere. */}
      {target !== null ? (
        <Link to={target} className="library-detail-poster">
          {poster}
        </Link>
      ) : (
        <div className="library-detail-poster">{poster}</div>
      )}

      {/* Text column. Meta, genres and summary each drop out when empty. */}
      <div className="library-detail-body">
        <div className="library-detail-title-row">
          {target !== null ? (
            <Link to={target} className="library-detail-title">
              {item.title}
            </Link>
          ) : (
            <span className="library-detail-title">{item.title}</span>
          )}
          <span className="stats-tag">{typeLabel}</span>
        </div>

        {metaParts.length > 0 ? (
          <p className="library-detail-meta">{metaParts.join(" · ")}</p>
        ) : null}

        {genresLabel !== "" ? (
          <p className="library-detail-genres">{genresLabel}</p>
        ) : null}

        {summary !== null ? (
          <p className="library-detail-summary">{summary}</p>
        ) : null}
      </div>
    </div>
  );
}
