import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { libraryImageUrl } from "../api/library";
import { fetchContinueWatching, type ContinueItem } from "../api/watch";

function continueLink(item: ContinueItem): string {
  return item.type === "movie"
    ? `/watch/item/${item.ratingKey}`
    : `/watch/episode/${item.ratingKey}`;
}

function ContinueProgressBar({
  viewOffset,
  duration,
}: {
  viewOffset: number | null;
  duration: number | null;
}) {
  if (
    viewOffset === null ||
    viewOffset <= 0 ||
    duration === null ||
    duration <= 0
  ) {
    return null;
  }

  const rawPercent = (viewOffset / duration) * 100;
  if (!Number.isFinite(rawPercent)) {
    return null;
  }
  const percent = Math.min(100, Math.max(1, rawPercent));
  const labelPercent = Math.round(percent);

  return (
    <div
      className="media-progress"
      role="progressbar"
      aria-valuenow={labelPercent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${labelPercent}% watched`}
    >
      <div
        className="media-progress-fill"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export function ContinueWatchingRail() {
  const [items, setItems] = useState<ContinueItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchContinueWatching().then((result) => {
      if (!cancelled) {
        setItems(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (items === null || items.length === 0) {
    return null;
  }

  return (
    <section className="continue-rail" aria-label="Continue Watching">
      <h2 className="continue-rail-heading">Continue Watching</h2>
      <div className="continue-rail-scroll">
        {items.map((item) => {
          const posterSrc = item.thumb ? libraryImageUrl(item.thumb) : null;
          return (
            <Link
              key={item.ratingKey}
              to={continueLink(item)}
              className="continue-rail-card"
            >
              <div className="continue-rail-poster media-poster">
                {posterSrc ? (
                  <img src={posterSrc} alt="" loading="lazy" />
                ) : (
                  <div className="media-poster-placeholder" aria-hidden="true">
                    No poster
                  </div>
                )}
                <ContinueProgressBar
                  viewOffset={item.viewOffset}
                  duration={item.duration}
                />
              </div>
              <div className="continue-rail-meta">
                <span className="continue-rail-title">{item.title}</span>
                {item.subtitle !== null ? (
                  <span className="continue-rail-subtitle muted">
                    {item.subtitle}
                  </span>
                ) : null}
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
