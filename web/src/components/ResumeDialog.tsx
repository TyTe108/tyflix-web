// The "Resume from 42:17" prompt that covers the player when you open
// something you'd already started.
//
// WatchPage shows this when Plex reports a saved position for the current user
// and the title isn't essentially finished. That position comes from progress
// reporting, so the offer works whether you stopped in a browser or on the TV.
// Playback stays paused behind the dialog until you answer.
//
// There's no cancel. Escape resolves to Resume, because WatchPage passes the
// same handler for both, and the scrim isn't clickable. Every way out of this
// dialog starts playback.
import { useEffect, useRef } from "react";

export type ResumeDialogProps = {
  /** Saved position in seconds. Comes from Plex's viewOffset, converted by WatchPage. */
  positionSeconds: number;
  /** Runtime in seconds, or null when unknown, which drops the "min left" note. */
  durationSeconds: number | null;
  onResume: () => void;
  onStartOver: () => void;
  /** Escape key. WatchPage wires this to the same handler as onResume. */
  onClose: () => void;
};

/**
 * Formats a position as h:mm:ss, or m:ss under an hour.
 *
 * Exported, though nothing outside this file imports it today.
 */
export function formatResumeTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Modal over the player offering Resume or Start from the beginning.
 *
 * Rendered only while the offer is live. WatchPage unmounts it the moment
 * either button is pressed, so it doesn't manage its own open state.
 */
export function ResumeDialog({
  positionSeconds,
  durationSeconds,
  onResume,
  onStartOver,
  onClose,
}: ResumeDialogProps) {
  const resumeButtonRef = useRef<HTMLButtonElement>(null);

  // Pull focus to Resume on mount so Enter answers the prompt straight away.
  useEffect(() => {
    resumeButtonRef.current?.focus();
  }, []);

  // Escape closes. Bound to window rather than the dialog, because focus can be
  // sitting on the player shell behind it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const timeLabel = formatResumeTime(positionSeconds);
  // "n min left", rounded up to at least 1 so the tail of a film never reads
  // "0 min left". Skipped entirely when the runtime is unknown or already past.
  const minutesLeft =
    durationSeconds !== null &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > positionSeconds
      ? Math.max(1, Math.round((durationSeconds - positionSeconds) / 60))
      : null;

  return (
    <div className="watch-resume-scrim" role="presentation">
      <div
        className="watch-resume-dialog"
        role="dialog"
        aria-labelledby="watch-resume-title"
      >
        <h2 id="watch-resume-title" className="watch-resume-title">
          Resume from {timeLabel}
          {minutesLeft !== null ? (
            <span className="watch-resume-remaining"> · {minutesLeft} min left</span>
          ) : null}
        </h2>
        <div className="watch-resume-actions">
          <button
            ref={resumeButtonRef}
            type="button"
            className="btn"
            onClick={onResume}
          >
            Resume
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={onStartOver}
          >
            Start from the beginning
          </button>
        </div>
      </div>
    </div>
  );
}
