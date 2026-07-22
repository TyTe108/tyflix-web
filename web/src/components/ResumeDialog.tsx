import { useEffect, useRef } from "react";

export type ResumeDialogProps = {
  positionSeconds: number;
  durationSeconds: number | null;
  onResume: () => void;
  onStartOver: () => void;
  onClose: () => void;
};

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

export function ResumeDialog({
  positionSeconds,
  durationSeconds,
  onResume,
  onStartOver,
  onClose,
}: ResumeDialogProps) {
  const resumeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    resumeButtonRef.current?.focus();
  }, []);

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
