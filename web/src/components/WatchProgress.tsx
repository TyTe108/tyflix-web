// The little watch-state marker drawn over a poster: a progress bar if you're
// partway through, a tick if you've finished it, nothing if you haven't started.
//
// LibraryCard and LibraryDetailRow both use it, which is why the two Library
// layouts agree about what you've seen. The numbers behind it are per-user, not
// per-server. The backend asks Plex with the caller's own token, so viewOffset
// and viewCount describe the person browsing rather than the server owner.
// Getting that token wrong once broke watch state for every shared account.

export type WatchProgressProps = {
  viewOffset: number | null; // ms into the title, per Plex
  viewCount: number | null; // completed plays; > 0 means watched
  runtime: number | null; // minutes
  durationMs?: number | null; // ms, preferred over runtime when present
};

// Picks the denominator for the percentage. Prefers the exact millisecond
// duration and falls back to the rounded runtime in minutes, so an item with
// only a runtime still gets a bar.
function resolveDurationMs(
  runtime: number | null,
  durationMs?: number | null,
): number | null {
  if (
    typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs > 0
  ) {
    return durationMs;
  }
  if (runtime !== null && runtime > 0) {
    return runtime * 60_000;
  }
  return null;
}

/**
 * Renders whichever watch-state marker fits, or nothing.
 *
 * In-progress wins over watched, so re-watching something already finished
 * shows the bar rather than the tick. Returns null when the item is untouched,
 * or when there's a position but no duration to measure it against.
 */
export function WatchProgress({
  viewOffset,
  viewCount,
  runtime,
  durationMs,
}: WatchProgressProps) {
  const effectiveDurationMs = resolveDurationMs(runtime, durationMs);
  const isInProgress =
    viewOffset !== null &&
    viewOffset > 0 &&
    effectiveDurationMs !== null;

  // Partway through: draw the bar. Clamped to 1-100, so a few seconds in still
  // shows something and a position past the runtime doesn't overflow the poster.
  if (isInProgress) {
    const rawPercent = (viewOffset / effectiveDurationMs) * 100;
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

  // Finished at least once, nothing in progress: the tick.
  if (viewCount !== null && viewCount > 0) {
    return (
      <span className="media-watched-badge" aria-label="Watched">
        <span aria-hidden="true">✓</span>
      </span>
    );
  }

  return null;
}
