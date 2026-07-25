/**
 * Load the current title onto the active Cast session (Default Media Receiver).
 * Caller must only invoke this while CastState is CONNECTED.
 *
 * Chromecast plays Plex's DASH (start.mpd), not HLS — verified on-device.
 */

export type CastLoadMediaInput = {
  contentUrl: string;
  title: string | null;
  subheading: string | null;
};

export function loadMediaOnCast(input: CastLoadMediaInput): Promise<void> {
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

  const mediaInfo = new chrome.cast.media.MediaInfo(
    input.contentUrl,
    "application/dash+xml",
  );
  mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;

  const metadata = new chrome.cast.media.GenericMediaMetadata();
  if (input.title !== null && input.title !== "") {
    metadata.title = input.title;
  }
  if (input.subheading !== null && input.subheading !== "") {
    metadata.subtitle = input.subheading;
  }
  mediaInfo.metadata = metadata;

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.autoplay = true;

  return session.loadMedia(request).then(() => undefined);
}
