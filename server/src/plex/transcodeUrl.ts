// Builds Plex's universal-transcode URLs for browser (HLS) and Cast (DASH)
// playback, forcing a transcode to H.264/AAC so HEVC (H.265) and other
// undecodable sources are converted rather than direct-played or stream-copied.
//
// UNVERIFIED (do not treat as gospel): the exact universal-transcode parameter
// set, and whether the X-Plex-Client-Profile-Extra below reliably forces H.264
// for HEVC sources, are best-effort from Plex docs + plex-for-kodi + dart_plex.
// The plan is to read the live /decision response (via the admin probe) and
// iterate the profile if Plex still direct-plays or stream-copies HEVC.
//
// NOTE: fetching start.m3u8 / start.mpd actually STARTS a transcode session on
// the server; the /decision variant does not, which is why the probe uses
// decision.

// Everything needed to address one transcode session. The caller supplies the
// connection (from connection.ts) and the token (from transientToken.ts); this
// file does no I/O and knows nothing about either.
export type BuildTranscodeUrlParams = {
  // Direct plex.direct base URL to stream from, e.g.
  // https://1-2-3-4.abc.plex.direct:32400 (no trailing slash required).
  connectionUri: string;
  ratingKey: string;
  token: string;
  clientId: string;
  sessionId: string;
  // Optional transcode-tuning params — omitted keys are not emitted, so the
  // URL stays byte-identical to the fixed-param baseline when all are absent.
  maxVideoBitrate?: number; // kbps
  videoResolution?: string; // "WxH", e.g. "1280x720"
  audioStreamID?: string;
  subtitleStreamID?: string;
  // UNVERIFIED against live Plex: param name/behavior (seconds) will be
  // validated when a caller first uses it (17.5 / Phase 18).
  offset?: number;
};

// HLS and DASH take identical params. The alias is kept so the HLS call sites
// read as HLS.
export type BuildHlsUrlParams = BuildTranscodeUrlParams;

// The literal colon segment is Plex's own path convention, not a typo.
const TRANSCODE_BASE_PATH = "/video/:/transcode/universal";

// Advertise an HLS / H.264 video / AAC audio transcode target. Combined with
// directPlay=0 this steers Plex to transcode HEVC/other sources to H.264 rather
// than serving the original codec. UNVERIFIED — may need tightening (e.g. a
// codec limitation) if the live decision still copies HEVC.
const H264_HLS_PROFILE_EXTRA =
  "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)";

// DASH variant verified on-device against the Default Media Receiver. Keep
// container=mpegts even though it looks odd for DASH — that is what played.
const H264_DASH_PROFILE_EXTRA =
  "add-transcode-target(type=videoProfile&context=streaming&protocol=dash&container=mpegts&videoCodec=h264&audioCodec=aac)";

// Shared builder; pathSegment is "start.m3u8" / "start.mpd" (real stream) or
// "decision".
// Pure string work, no I/O. The only way it fails is an invalid tuning param,
// and it throws a plain Error for those, not one of the typed Plex errors.
function buildTranscodeUrl(
  pathSegment: string,
  protocol: "hls" | "dash",
  profileExtra: string,
  params: BuildTranscodeUrlParams,
): string {
  // URLSearchParams handles the encoding, which matters more than it looks:
  // the metadata path is full of slashes and the profile-extra is full of
  // parens and ampersands. Hand-built, this string would fall apart.
  const search = new URLSearchParams();
  // What to play. mediaIndex/partIndex 0 takes the first media version and its
  // first part, which is the only shape this app handles today.
  search.set("path", `/library/metadata/${params.ratingKey}`);
  search.set("protocol", protocol);
  search.set("mediaIndex", "0");
  search.set("partIndex", "0");
  search.set("fastSeek", "1");
  // directPlay=0 forbids serving the original file untouched; directStream=1
  // still lets Plex remux the container when the codec is already compatible.
  search.set("directPlay", "0");
  search.set("directStream", "1");
  // Explicit target codecs reinforce the profile-extra transcode target.
  search.set("videoCodec", "h264");
  search.set("audioCodec", "aac");
  // Always burn-ready: with no subtitle selected on the part this is a no-op.
  search.set("subtitles", "burn");
  // Who's asking. The session id goes out under both names Plex uses, with the
  // same value, so the two never drift apart and split one playback into two
  // transcode sessions.
  search.set("X-Plex-Platform", "Chrome");
  search.set("X-Plex-Client-Identifier", params.clientId);
  search.set("X-Plex-Session-Identifier", params.sessionId);
  search.set("session", params.sessionId);
  search.set("X-Plex-Client-Profile-Extra", profileExtra);
  search.set("X-Plex-Token", params.token);

  // Optional tuning params appended after the fixed set so the omitted-case
  // query string is unchanged.
  if (params.maxVideoBitrate !== undefined) {
    if (
      !Number.isInteger(params.maxVideoBitrate) ||
      params.maxVideoBitrate <= 0
    ) {
      throw new Error("maxVideoBitrate must be a positive integer");
    }
    search.set("maxVideoBitrate", String(params.maxVideoBitrate));
  }
  if (params.videoResolution !== undefined) {
    if (!/^\d+x\d+$/.test(params.videoResolution)) {
      throw new Error('videoResolution must match "WxH" (e.g. "1280x720")');
    }
    search.set("videoResolution", params.videoResolution);
  }
  if (params.audioStreamID !== undefined) {
    if (params.audioStreamID.trim() === "") {
      throw new Error("audioStreamID must be a non-empty string");
    }
    search.set("audioStreamID", params.audioStreamID);
  }
  if (params.subtitleStreamID !== undefined) {
    if (params.subtitleStreamID.trim() === "") {
      throw new Error("subtitleStreamID must be a non-empty string");
    }
    search.set("subtitleStreamID", params.subtitleStreamID);
  }
  if (params.offset !== undefined) {
    if (!Number.isFinite(params.offset) || params.offset < 0) {
      throw new Error("offset must be a finite number >= 0");
    }
    search.set("offset", String(params.offset));
  }

  // Strip any trailing slash off the base so a caller that passes one doesn't
  // end up with a double slash in the path. Covered by the tests both ways.
  const base = params.connectionUri.replace(/\/+$/, "");
  return `${base}${TRANSCODE_BASE_PATH}/${pathSegment}?${search.toString()}`;
}

// Browser HLS stream URL (fetching it starts a real transcode).
/**
 * The URL hls.js loads in the player.
 *
 * routes/watch.ts builds two of these per play, one on the remote plex.direct
 * address and one on the local, sharing a single session id so a browser that
 * falls from one to the other doesn't spawn a second transcode.
 *
 * @throws Error when a tuning param is malformed: a non-positive or fractional
 * maxVideoBitrate, a videoResolution that isn't "WxH", a blank stream id, or a
 * negative offset.
 */
export function buildHlsUrl(params: BuildHlsUrlParams): string {
  return buildTranscodeUrl("start.m3u8", "hls", H264_HLS_PROFILE_EXTRA, params);
}

// Cast DASH stream URL (fetching it starts a real transcode). Distinct session
// id from HLS so browser + receiver never share one transcode session.
/**
 * The URL handed to a Chromecast receiver.
 *
 * DASH rather than HLS because the Default Media Receiver wouldn't play Plex's
 * HLS. Call buildDashDecisionUrl first; Plex rejects start.mpd on a session it
 * hasn't made a decision for.
 *
 * @throws Error on the same malformed tuning params as buildHlsUrl.
 */
export function buildDashUrl(params: BuildTranscodeUrlParams): string {
  return buildTranscodeUrl(
    "start.mpd",
    "dash",
    H264_DASH_PROFILE_EXTRA,
    params,
  );
}

// Same URL against the /decision endpoint, which reports Plex's transcode
// decision WITHOUT starting a transcode.
/**
 * Asks Plex what it would do with this HLS request without committing to it.
 * Useful for checking whether the profile above is actually forcing H.264.
 *
 * Nothing in the server calls this today. It's exported and tested, waiting on
 * the probe described in the file header.
 *
 * @throws Error on the same malformed tuning params as buildHlsUrl.
 */
export function buildHlsDecisionUrl(params: BuildHlsUrlParams): string {
  return buildTranscodeUrl("decision", "hls", H264_HLS_PROFILE_EXTRA, params);
}

// DASH /decision handshake — required before start.mpd or Plex returns 400
// "session lacking decision". Same session id / params as buildDashUrl.
/**
 * The handshake the cast flow has to make before it can start a DASH stream.
 *
 * Not optional and not a probe, unlike the HLS decision URL. routes/watch.ts
 * returns it alongside the DASH URLs, built from the same params, and the tests
 * check the two match on every key except the path segment.
 *
 * @throws Error on the same malformed tuning params as buildHlsUrl.
 */
export function buildDashDecisionUrl(params: BuildTranscodeUrlParams): string {
  return buildTranscodeUrl("decision", "dash", H264_DASH_PROFILE_EXTRA, params);
}
