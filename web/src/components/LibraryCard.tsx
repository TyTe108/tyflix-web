import { Link } from "react-router-dom";
import { libraryImageUrl, type LibraryItem } from "../api/library";

export function LibraryCard({ item }: { item: LibraryItem }) {
  const yearLabel = item.year !== null ? String(item.year) : "—";
  const typeLabel = item.type === "show" ? "TV" : "Movie";
  const posterSrc = item.thumb ? libraryImageUrl(item.thumb) : null;

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

  if (item.tmdbId !== null) {
    const mediaType = item.type === "show" ? "tv" : "movie";
    return (
      <Link to={`/media/${mediaType}/${item.tmdbId}`} className="media-card">
        {card}
      </Link>
    );
  }

  if (item.type !== "show") {
    return (
      <Link to={`/watch/item/${item.ratingKey}`} className="media-card">
        {card}
      </Link>
    );
  }

  return <div className="media-card">{card}</div>;
}
