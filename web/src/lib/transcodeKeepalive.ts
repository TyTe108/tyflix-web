// Pings a Plex transcode session so an idle stream stays alive.
//
// On 2026-11-06 a ping every 30 s kept a test session alive through 215 s of
// idle while an unpinged twin died, and through 25 minutes in a longer soak
// (spec E10, E11). Plex kills an idle session about 181 s after its last
// request. A paused player asks for nothing, so without this ping a pause
// ends the session and the page has to restart it.
//
// The request is the one the probe recorded. GET the stream's origin at
// /video/:/transcode/universal/ping with the session id and the transient
// token, and no other parameters or headers. mode "cors" because the host is
// plex.direct, a different origin from the page. cache "no-store" because the
// URL repeats every 30 s and a cached 200 would hide a session that has died.
// The URL carries the token, so it is never logged whole.

/** How often an idle stream pings its Plex session. There is no cap. */
export const KEEPALIVE_INTERVAL_MS = 30_000;

/** What one ping found out about the session. */
export type PingResult = "alive" | "dead" | "unknown";

/**
 * The ping URL for the session playing sourceUrl. The origin comes from
 * sourceUrl. The query is exactly session and X-Plex-Token, both encoded.
 * Throws when sourceUrl is not absolute or the session id or token is empty.
 * The message names the problem and never includes the token or the source
 * URL, because that URL's query holds the token too.
 */
export function buildPingUrl(
  sourceUrl: string,
  sessionId: string,
  token: string,
): string {
  let origin: string;
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.origin === "null" || parsed.host === "") {
      throw new Error("no host");
    }
    origin = parsed.origin;
  } catch {
    throw new Error("The ping source URL must be absolute.");
  }
  if (sessionId === "") {
    throw new Error("The ping needs a session id.");
  }
  if (token === "") {
    throw new Error("The ping needs a token.");
  }
  const query = new URLSearchParams({
    session: sessionId,
    "X-Plex-Token": token,
  });
  return `${origin}/video/:/transcode/universal/ping?${query.toString()}`;
}

/**
 * Asks Plex whether this session is still alive. One fetch, with mode "cors"
 * and cache "no-store" and no custom headers. 200 is "alive", 404 is "dead",
 * and any other status, a rejected fetch, or a fetch that throws is
 * "unknown". This function itself never throws or rejects, so a failed ping
 * cannot take the player down.
 */
export async function pingTranscodeSession(url: string): Promise<PingResult> {
  try {
    const response = await fetch(url, { mode: "cors", cache: "no-store" });
    if (response.status === 200) {
      return "alive";
    }
    if (response.status === 404) {
      return "dead";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
