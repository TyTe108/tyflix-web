// Hands one title to the connected Chromecast. The only place in the app that
// calls CastSession.loadMedia.
//
// WatchPage drives it from the subscribeSessionReady effect, once the receiver
// is actually up, using URLs the server built in
// server/src/plex/transcodeUrl.ts. Retries, dedupe and error recovery all live
// in that effect. This function does the handshake, builds the MediaInfo, and
// resolves or rejects.
//
// Two facts here cost real debugging. The Default Media Receiver plays Plex's
// DASH but wouldn't play its HLS, so casting streams start.mpd while the
// in-browser player streams HLS off the same Plex server. Two manifest formats
// live at once, on purpose. And Plex refuses to serve start.mpd for a session
// it hasn't made a transcode decision for: skip the /decision call and it comes
// back 400 "session lacking decision".

// Everything the receiver needs for one title. WatchPage picks the local or
// remote plex.direct address before it gets here, so both URLs are already
// resolved.
export type CastLoadMediaInput = {
  // Plex's start.mpd, which begins a real transcode when it's fetched.
  contentUrl: string;
  // The /decision URL for the same session. Same params, different path.
  decisionUrl: string;
  // Shown on the TV while loading and playing. Null skips the field.
  title: string | null;
  subheading: string | null;
};

// The handshake Plex demands before it'll serve start.mpd.
//
// It goes out from the browser rather than the receiver, which works because
// the session is identified by the query params in the URL and not by who
// asked. A failure here isn't treated as fatal: warn, try the load anyway, and
// let loadMedia's own rejection be the signal the caller acts on.
async function fetchDashDecision(decisionUrl: string): Promise<void> {
  try {
    // Cross-origin to plex.direct, hence the explicit CORS mode. no-store so a
    // cached response can't stand in for an actual handshake.
    const res = await fetch(decisionUrl, { mode: "cors", cache: "no-store" });
    if (!res.ok) {
      console.warn(
        `[cast] DASH /decision returned HTTP ${res.status}; continuing to loadMedia.`,
      );
    }
  } catch (err: unknown) {
    console.warn(
      "[cast] DASH /decision fetch failed; continuing to loadMedia.",
      err,
    );
  }
}

/**
 * Starts playback of one title on whatever Cast session is currently live.
 *
 * Only call this once the session is ready. subscribeSessionReady is how you
 * know, since CastState.CONNECTED can land before the receiver will take a
 * load. The session is read from CastContext here rather than passed in, so
 * there's no chance of loading onto a session that has already gone away.
 *
 * @returns a promise that resolves when the receiver accepts the load. That's
 * acceptance, not playback: a cold Plex transcode can take a while to produce
 * frames, which is why WatchPage separately checks for a media session
 * afterwards.
 * @throws Error when the Cast SDK isn't loaded or no session is active.
 * Rejects with whatever the SDK gives back when the receiver refuses the load.
 */
export async function loadMediaOnCast(
  input: CastLoadMediaInput,
): Promise<void> {
  if (
    !window.cast?.framework ||
    typeof chrome === "undefined" ||
    !chrome.cast?.media
  ) {
    return Promise.reject(new Error("Cast framework not available"));
  }

  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  if (session === null) {
    return Promise.reject(new Error("No active Cast session"));
  }

  // Has to come first. Plex rejects start.mpd on an undecided session.
  await fetchDashDecision(input.decisionUrl);

  // BUFFERED rather than LIVE: this is a seekable transcode with a known
  // duration, and the receiver's scrubber behaves accordingly.
  const mediaInfo = new chrome.cast.media.MediaInfo(
    input.contentUrl,
    "application/dash+xml",
  );
  mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;

  // Only fields with real content get set. A null or an empty string is left
  // off the metadata object entirely rather than sent as "".
  const metadata = new chrome.cast.media.GenericMediaMetadata();
  if (input.title !== null && input.title !== "") {
    metadata.title = input.title;
  }
  if (input.subheading !== null && input.subheading !== "") {
    metadata.subtitle = input.subheading;
  }
  mediaInfo.metadata = metadata;

  // autoplay because the user already pressed play in the browser. Casting
  // moves that playback to the TV; it isn't a second decision to make.
  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.autoplay = true;

  // The SDK resolves with a value nobody here uses, so flatten it to void and
  // keep the caller's contract simple.
  return session.loadMedia(request).then(() => undefined);
}
