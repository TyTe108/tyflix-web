import { Link } from "react-router-dom";
import {
  libraryImageUrl,
  libraryItemTarget,
  type LibraryItem,
} from "../api/library";
import { WatchProgress } from "./WatchProgress";

export function LibraryCard({ item }: { item: LibraryItem }) {
  const yearLabel = item.year !== null ? String(item.year) : "—";
  const typeLabel = item.type === "show" ? "TV" : "Movie";
  const posterSrc = item.thumb ? libraryImageUrl(item.thumb) : null;
  const target = libraryItemTarget(item);

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
