import { useEffect, useState } from "react";

export type UpNextCardProps = {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  thumbUrls: string[];
  secondsRemaining: number | null;
  onPlayNow: () => void;
  onDismiss: () => void;
};

export function UpNextCard({
  seasonNumber,
  episodeNumber,
  title,
  thumbUrls,
  secondsRemaining,
  onPlayNow,
  onDismiss,
}: UpNextCardProps) {
  const [thumbIndex, setThumbIndex] = useState(0);
  // Key on URL content, not array identity, so a new equal array never resets
  // a settled local→remote fallback.
  const thumbUrlsKey = thumbUrls.join("\0");

  useEffect(() => {
    setThumbIndex(0);
  }, [thumbUrlsKey]);

  const thumbUrl =
    thumbIndex >= 0 && thumbIndex < thumbUrls.length
      ? thumbUrls[thumbIndex]
      : null;

  return (
    <div className="watch-upnext" role="dialog" aria-label="Up Next">
      <p className="watch-upnext-label">Up Next</p>
      {thumbUrl !== null ? (
        <img
          className="watch-upnext-thumb"
          src={thumbUrl}
          alt=""
          onError={() => {
            setThumbIndex((index) => index + 1);
          }}
        />
      ) : null}
      <p className="watch-upnext-meta">
        S{seasonNumber}E{episodeNumber} · {title}
      </p>
      {typeof secondsRemaining === "number" ? (
        <p className="watch-upnext-countdown">
          Starting in {secondsRemaining}s
        </p>
      ) : null}
      <div className="watch-upnext-actions">
        <button type="button" className="btn" onClick={onPlayNow}>
          Play now
        </button>
        <button type="button" className="btn secondary" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
