// Builds Plex's universal-transcode HLS URL for browser playback, forcing a
// transcode to H.264/AAC so HEVC (H.265) and other browser-undecodable sources
// are converted rather than direct-played or stream-copied.
//
// UNVERIFIED (do not treat as gospel): the exact universal-transcode parameter
// set, and whether the X-Plex-Client-Profile-Extra below reliably forces H.264
// for HEVC sources, are best-effort from Plex docs + plex-for-kodi + dart_plex.
// The plan is to read the live /decision response (via the admin probe) and
// iterate the profile if Plex still direct-plays or stream-copies HEVC.
//
// NOTE: fetching start.m3u8 actually STARTS a transcode session on the server;
// the /decision variant does not, which is why the probe uses decision.

export type BuildHlsUrlParams = {
  // Direct plex.direct base URL to stream from, e.g.
  // https://1-2-3-4.abc.plex.direct:32400 (no trailing slash required).
  connectionUri: string;
  ratingKey: string;
  token: string;
  clientId: string;
  sessionId: string;
};

const TRANSCODE_BASE_PATH = "/video/:/transcode/universal";

// Advertise an HLS / H.264 video / AAC audio transcode target. Combined with
// directPlay=0 this steers Plex to transcode HEVC/other sources to H.264 rather
// than serving the original codec. UNVERIFIED — may need tightening (e.g. a
// codec limitation) if the live decision still copies HEVC.
const H264_HLS_PROFILE_EXTRA =
  "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)";

// Shared builder; pathSegment is "start.m3u8" (real stream) or "decision".
function buildTranscodeUrl(
  pathSegment: string,
  params: BuildHlsUrlParams,
): string {
  const search = new URLSearchParams();
  search.set("path", `/library/metadata/${params.ratingKey}`);
  search.set("protocol", "hls");
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
  search.set("X-Plex-Platform", "Chrome");
  search.set("X-Plex-Client-Identifier", params.clientId);
  search.set("X-Plex-Session-Identifier", params.sessionId);
  search.set("session", params.sessionId);
  search.set("X-Plex-Client-Profile-Extra", H264_HLS_PROFILE_EXTRA);
  search.set("X-Plex-Token", params.token);

  const base = params.connectionUri.replace(/\/+$/, "");
  return `${base}${TRANSCODE_BASE_PATH}/${pathSegment}?${search.toString()}`;
}

// Browser HLS stream URL (fetching it starts a real transcode).
export function buildHlsUrl(params: BuildHlsUrlParams): string {
  return buildTranscodeUrl("start.m3u8", params);
}

// Same URL against the /decision endpoint, which reports Plex's transcode
// decision WITHOUT starting a transcode.
export function buildHlsDecisionUrl(params: BuildHlsUrlParams): string {
  return buildTranscodeUrl("decision", params);
}
