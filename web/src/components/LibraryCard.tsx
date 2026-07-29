// The poster tile in the Library grid: artwork, title, type tag, year, and a
// progress bar or watched tick from WatchProgress.
//
// LibraryPage renders this in grid mode and LibraryDetailRow in detail mode.
// Same item, same watch state, different shape. Posters come through the
// backend's image proxy rather than straight from Plex, because the browser has
// no Plex token to authenticate with.
//
// MediaCard is the equivalent for TMDB discovery results. This one is for
// things that are already on the server.
import { Link } from "react-router-dom";
import {
  libraryImageUrl,
  libraryItemTarget,
  type LibraryItem,
} from "../api/library";
import { WatchProgress } from "./WatchProgress";

/**
 * One library item as a poster tile.
 *
 * Falls back to a plain div when `libraryItemTarget` returns null, which is a
 * show Plex holds that never matched a TMDB id. The tile still renders, it just
 * doesn't go anywhere.
 */
export function LibraryCard({ item }: { item: LibraryItem }) {
  const yearLabel = item.year !== null ? String(item.year) : "—";
  const typeLabel = item.type === "show" ? "TV" : "Movie";
  const posterSrc = item.thumb ? libraryImageUrl(item.thumb) : null;
  const target = libraryItemTarget(item);

  // Shared between the linked and unlinked branches below.
  const card = (
    <>
      <div className="media-poster">
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
      </div>
      <div className="media-card-body">
        <div className="media-card-title-row">
          <span className="media-card-title">{item.title}</span>
          <span className="stats-tag">{typeLabel}</span>
        </div>
        <p className="media-card-year muted">{yearLabel}</p>
      </div>
    </>
  );

  if (target !== null) {
    return (
      <Link to={target} className="media-card">
        {card}
      </Link>
    );
  }

  return <div className="media-card">{card}</div>;
}
