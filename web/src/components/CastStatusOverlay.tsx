// The banner over the player that says playback has moved to a Chromecast.
//
// WatchPage renders it whenever a Cast session is connected. The browser tears
// down its own video at that point, so without this the player area would just
// go black with no explanation. Two states: "starting" until the receiver
// reports real media state, then "playing", which stays up for the rest of the
// session including while paused.
//
// Up Next outranks it. When both could show, WatchPage suppresses this one.
type CastStatusOverlayProps = {
  /** "starting" while the receiver is still loading; "playing" once it has media. */
  mode: "starting" | "playing";
  /** Chromecast's friendly name. Null falls back to "your TV". */
  deviceName: string | null;
};

// Treats a blank or whitespace-only device name as no name at all.
function resolveDeviceLabel(deviceName: string | null): string | null {
  if (typeof deviceName !== "string") {
    return null;
  }
  const trimmed = deviceName.trim();
  return trimmed !== "" ? trimmed : null;
}

/**
 * Cast status banner. Purely a readout, no controls. Stopping the cast is the
 * cast button's job over in PlayerControls.
 *
 * It's an aria-live region, so the announcement lands when the state changes
 * rather than only for whoever happens to be looking at the screen.
 */
export function CastStatusOverlay({
  mode,
  deviceName,
}: CastStatusOverlayProps) {
  const name = resolveDeviceLabel(deviceName);
  // Four wordings: starting or playing, crossed with named device or not.
  const label =
    mode === "starting"
      ? name !== null
        ? `Starting on ${name}…`
        : "Starting on your TV…"
      : name !== null
        ? `Playing on ${name}`
        : "Playing on your TV";

  return (
    <div
      className={
        mode === "starting"
          ? "watch-cast-status watch-cast-status--starting"
          : "watch-cast-status watch-cast-status--playing"
      }
      role="status"
      aria-live="polite"
    >
      <IconCast />
      <p className="watch-cast-status-label">{label}</p>
    </div>
  );
}

// Same glyph as the cast button in PlayerControls, copied rather than shared.
function IconCast() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"
        fill="currentColor"
      />
    </svg>
  );
}
