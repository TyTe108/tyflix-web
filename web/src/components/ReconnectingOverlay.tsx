// The banner over the player that says the stream is being restarted.
//
// WatchPage renders it from the moment a fatal hls.js error starts a recovery
// until the restarted stream plays again. Without it the video would sit frozen
// with no explanation while a new descriptor is fetched and loaded.
//
// It reuses the Cast status banner's classes, so it looks like the other
// full-player status messages and needs no styles of its own.

/**
 * Reconnecting banner. Purely a readout, with no controls. It is an aria-live
 * region, so the announcement lands when it appears.
 */
export function ReconnectingOverlay() {
  return (
    <div
      className="watch-cast-status watch-cast-status--starting"
      role="status"
      aria-live="polite"
    >
      <p className="watch-cast-status-label">Reconnecting…</p>
    </div>
  );
}
