// The Plex-style next-episode card that slides over the player near the end of
// an episode. Thumbnail, "S2E7 · Title", a countdown, Play now and Dismiss.
//
// WatchPage decides when it appears. The trigger is the credits marker Plex
// reports for the episode, with the last 30 seconds as a fallback so an episode
// Plex never marked still gets a card. The countdown is narrower than the card:
// it only shows inside that final 30 seconds, so a card raised early by a
// credits marker sits there without a ticking number until the end is close.
//
// Dismiss doesn't just hide the card. It cancels the auto-advance for this
// episode, so the player stops at the end instead of rolling on.
//
// This component is display only. It doesn't count down, navigate, or know
// what's next. Everything comes in as props.
import { useEffect, useState } from "react";

export type UpNextCardProps = {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  /** Thumbnail candidates in preference order, local Plex address first. */
  thumbUrls: string[];
  /** null hides the countdown line, which is how the credits-marker case reads
   *  before the last 30 seconds. */
  secondsRemaining: number | null;
  onPlayNow: () => void;
  /** Also cancels the auto-advance, not just this card. */
  onDismiss: () => void;
};

/**
 * Up Next overlay for the last stretch of an episode.
 *
 * The thumbnail walks `thumbUrls` on error, which is how it falls back from the
 * LAN plex.direct address to the remote one. Running off the end of the list
 * just drops the image and keeps the rest of the card.
 */
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

  // Only a genuinely different set of URLs restarts the fallback. The card
  // re-renders on every timeupdate while it's visible, and resetting here would
  // send a settled remote thumbnail back to the local URL that already failed.
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
      {/* Each load failure steps to the next candidate URL. Past the end,
          thumbUrl is null and the image is dropped. */}
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
