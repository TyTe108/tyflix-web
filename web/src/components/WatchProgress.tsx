export type WatchProgressProps = {
  viewOffset: number | null;
  viewCount: number | null;
  runtime: number | null;
};

export function WatchProgress({
  viewOffset,
  viewCount,
  runtime,
}: WatchProgressProps) {
  const isInProgress =
    viewOffset !== null &&
    viewOffset > 0 &&
    runtime !== null &&
    runtime > 0;

  if (isInProgress) {
    const durationMs = runtime * 60_000;
    const rawPercent = (viewOffset / durationMs) * 100;
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

  if (viewCount !== null && viewCount > 0) {
    return (
      <span className="media-watched-badge" aria-label="Watched">
        <span aria-hidden="true">✓</span>
      </span>
    );
  }

  return null;
}
