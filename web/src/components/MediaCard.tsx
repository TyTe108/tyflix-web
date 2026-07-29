// The poster tile for anything coming out of TMDB discovery, with the server's
// availability layered on the corner. Green for already here, amber for partly.
//
// Used by Discover, Watchlist, PersonPage, CollectionPage, and the
// recommendations rail on a media detail page. Every one of those lists is
// TMDB-keyed, so the card links to /media/:type/:tmdbId and never touches a
// Plex ratingKey. LibraryCard is the counterpart for things browsed out of Plex.
//
// The status corner is where the two id systems meet: TMDB gives the poster,
// Seerr's media records say whether that TMDB id is on the server.
import { Link } from "react-router-dom";
import {
  mediaStatusBadgeClass,
  type MediaType,
} from "../api/discover";
import {
  mediaStatusLabel,
  type MediaAvailabilityStatus,
} from "../api/requests";

// The trimmed-down shape a card needs. Every caller maps its own richer
// response down to this, which is what lets one card serve five pages.
export type MediaCardItem = {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  posterUrl: string | null;
  mediaStatus: MediaAvailabilityStatus | null; // null hides the corner badge
};

/**
 * Discovery poster tile linking to the title's detail page.
 *
 * A null `mediaStatus` means availability wasn't resolved for this item, so no
 * badge renders at all. That's not the same as "unknown", which is a real
 * status and does get its own badge.
 */
export function MediaCard({ item }: { item: MediaCardItem }) {
  const to = `/media/${item.mediaType}/${item.tmdbId}`;
  const yearLabel = item.year !== null ? String(item.year) : "—";

  return (
    <Link to={to} className="media-card">
      <div className="media-poster">
        {item.posterUrl ? (
          <img src={item.posterUrl} alt="" loading="lazy" />
        ) : (
          <div className="media-poster-placeholder" aria-hidden="true">
            No poster
          </div>
        )}
        {item.mediaStatus !== null ? (
          <span
            className={`media-status-corner ${mediaStatusBadgeClass(item.mediaStatus)}`}
          >
            {mediaStatusLabel(item.mediaStatus)}
          </span>
        ) : null}
      </div>
      <div className="media-card-body">
        <div className="media-card-title-row">
          <span className="media-card-title">{item.title}</span>
          <span className="stats-tag">
            {item.mediaType === "tv" ? "TV" : "Movie"}
          </span>
        </div>
        <p className="media-card-year muted">{yearLabel}</p>
      </div>
    </Link>
  );
}
