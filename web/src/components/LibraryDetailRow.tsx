import { Link } from "react-router-dom";
import { formatRuntime } from "../api/discover";
import {
  libraryImageUrl,
  libraryItemTarget,
  type LibraryItem,
} from "../api/library";
import { WatchProgress } from "./WatchProgress";

export function LibraryDetailRow({ item }: { item: LibraryItem }) {
  const target = libraryItemTarget(item);
  const typeLabel = item.type === "show" ? "TV" : "Movie";
  const posterSrc = item.thumb ? libraryImageUrl(item.thumb) : null;

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

  const genresLabel = item.genres.slice(0, 3).join(", ");
  const summary =
    item.summary !== null && item.summary.trim() !== "" ? item.summary : null;

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
      {target !== null ? (
        <Link to={target} className="library-detail-poster">
          {poster}
        </Link>
      ) : (
        <div className="library-detail-poster">{poster}</div>
      )}

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
