export type WatchProgressProps = {
  viewOffset: number | null;
  viewCount: number | null;
  runtime: number | null;
  durationMs?: number | null;
};

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

  if (viewCount !== null && viewCount > 0) {
    return (
      <span className="media-watched-badge" aria-label="Watched">
        <span aria-hidden="true">✓</span>
      </span>
    );
  }

  return null;
}
