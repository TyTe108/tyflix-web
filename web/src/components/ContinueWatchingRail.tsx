// The Continue Watching rail at the top of the Library page: a horizontal strip
// of half-finished titles, each a direct link back into the player.
//
// The list is Plex's own On Deck for the signed-in user, which is the same
// state the TV app reads. Stop a film halfway through in the living room and it
// turns up here. That works because playback anywhere reports its position back
// to Plex, so watch progress is per-user rather than owner-wide.
//
// Renders nothing at all when the list is empty or hasn't loaded, so the
// Library page doesn't reserve space for a rail that may never appear.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { libraryImageUrl } from "../api/library";
import { fetchContinueWatching, type ContinueItem } from "../api/watch";

// Both routes take a Plex ratingKey. Movies use /watch/item because an On Deck
// row carries no TMDB id, and /watch/item is the ratingKey-native movie route.
function continueLink(item: ContinueItem): string {
  return item.type === "movie"
    ? `/watch/item/${item.ratingKey}`
    : `/watch/episode/${item.ratingKey}`;
}

// The bar across the bottom of a poster. Floors at 1% so a title you only just
// started still shows a sliver rather than nothing.
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

/**
 * Continue Watching rail. Takes no props and fetches its own list on mount.
 *
 * Returns null when there's nothing to resume, so the caller can drop it in
 * unconditionally. LibraryPage does exactly that.
 */
export function ContinueWatchingRail() {
  const [items, setItems] = useState<ContinueItem[] | null>(null);

  // One fetch on mount, never refreshed. The fetch helper swallows its own
  // errors and hands back an empty array, so there's no error branch here.
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

  // null is still-loading, empty is nothing to resume. Neither draws anything.
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
