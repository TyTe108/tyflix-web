/**
 * Load the current title onto the active Cast session (Default Media Receiver).
 * Caller must only invoke this while CastState is CONNECTED.
 *
 * Chromecast plays Plex's DASH (start.mpd), not HLS — verified on-device.
 * Plex requires a /decision handshake for the session before start.mpd or it
 * returns 400 "session lacking decision".
 */

import { castDiag } from "./castDiag";

export type CastLoadMediaInput = {
  contentUrl: string;
  decisionUrl: string;
  title: string | null;
  subheading: string | null;
};

async function fetchDashDecision(decisionUrl: string): Promise<void> {
  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag("loadMediaOnCast", `decision fetch begin url=${decisionUrl}`);
  try {
    const res = await fetch(decisionUrl, { mode: "cors", cache: "no-store" });
    // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
    castDiag("loadMediaOnCast", `decision HTTP status=${res.status}`);
    if (!res.ok) {
      console.warn(
        `[cast] DASH /decision returned HTTP ${res.status}; continuing to loadMedia.`,
      );
    }
  } catch (err: unknown) {
    // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
    castDiag("loadMediaOnCast", "decision fetch error", err);
    console.warn(
      "[cast] DASH /decision fetch failed; continuing to loadMedia.",
      err,
    );
  }
}

export async function loadMediaOnCast(
  input: CastLoadMediaInput,
): Promise<void> {
  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag("loadMediaOnCast", "entry", {
    contentUrl: input.contentUrl,
    decisionUrl: input.decisionUrl,
  });

  const hasFramework = !!window.cast?.framework;
  const hasChromeCast =
    typeof chrome !== "undefined" && !!chrome.cast?.media;
  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag(
    "loadMediaOnCast",
    `precondition framework=${hasFramework} chrome.cast.media=${hasChromeCast}`,
  );

  if (!hasFramework || !hasChromeCast) {
    return Promise.reject(new Error("Cast framework not available"));
  }

  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag(
    "loadMediaOnCast",
    `precondition getCurrentSession=${session === null ? "null" : "ok"}`,
  );
  if (session === null) {
    return Promise.reject(new Error("No active Cast session"));
  }

  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag("loadMediaOnCast", `contentUrl=${input.contentUrl}`);
  await fetchDashDecision(input.decisionUrl);

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

  // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
  castDiag("loadMediaOnCast", "loadMedia called");
  return session.loadMedia(request).then(
    () => {
      // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
      castDiag("loadMediaOnCast", "loadMedia RESOLVED");
    },
    (err: unknown) => {
      // TEMPORARY [cast-diag] — remove once the cast load bug is fixed
      castDiag("loadMediaOnCast", "loadMedia REJECTED", err);
      throw err;
    },
  );
}
