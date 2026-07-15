import { Link } from "react-router-dom";
import {
  mediaStatusBadgeClass,
  type MediaType,
} from "../api/discover";
import {
  mediaStatusLabel,
  type MediaAvailabilityStatus,
} from "../api/requests";

export type MediaCardItem = {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  year: number | null;
  posterUrl: string | null;
  mediaStatus: MediaAvailabilityStatus | null;
};

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
