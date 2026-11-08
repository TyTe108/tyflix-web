// The ping URL and the one request that asks Plex whether a transcode session
// is still alive. The fixtures copy the 2026-11-06 exchange: status and
// Content-Type text/html. The 200 body is empty. The 404 body is the 85 bytes
// recorded for a stopped session.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPingUrl, pingTranscodeSession } from "./transcodeKeepalive";

const LOCAL_SOURCE =
  "https://local.example.plex.direct:32400/video/:/transcode/universal/start.m3u8?X-Plex-Token=old-token";
const REMOTE_SOURCE =
  "https://remote.example.plex.direct:32400/video/:/transcode/universal/start.m3u8?session=old";

function exactPingUrl(sourceUrl: string, sessionId: string, token: string): string {
  const origin = new URL(sourceUrl).origin;
  const query = new URLSearchParams({
    session: sessionId,
    "X-Plex-Token": token,
  });
  return `${origin}/video/:/transcode/universal/ping?${query.toString()}`;
}

// The body Plex returned for a stopped or unknown session on 2026-11-06.
const NOT_FOUND_BODY =
  "<html><head><title>Not Found</title></head><body><h1>404 Not Found</h1></body></html>";

function emptyHtml(status: number): Response {
  return new Response(status === 404 ? NOT_FOUND_BODY : "", {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildPingUrl", () => {
  it("builds the ping URL from the stream origin with the session and the token", () => {
    const sessionId = "session id/1";
    const token = "tok&en=1";

    const local = buildPingUrl(LOCAL_SOURCE, sessionId, token);
    const remote = buildPingUrl(REMOTE_SOURCE, sessionId, token);

    expect(local).toBe(exactPingUrl(LOCAL_SOURCE, sessionId, token));
    expect(remote).toBe(exactPingUrl(REMOTE_SOURCE, sessionId, token));
    expect(new URL(local).origin).not.toBe(new URL(remote).origin);

    for (const url of [local, remote]) {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/video/:/transcode/universal/ping");
      expect(Array.from(parsed.searchParams.keys())).toEqual([
        "session",
        "X-Plex-Token",
      ]);
      expect(parsed.searchParams.get("session")).toBe(sessionId);
      expect(parsed.searchParams.get("X-Plex-Token")).toBe(token);
    }
  });

  it("throws on a bad source, an empty session id or an empty token, and the message holds no token", () => {
    const token = "example-token-leak";
    const source = `https://local.example.plex.direct:32400/start.m3u8?X-Plex-Token=${token}`;
    const relative = `/video/start.m3u8?X-Plex-Token=${token}`;
    const runs = [
      { source: relative, run: () => buildPingUrl(relative, "session-1", token) },
      { source: "not a url", run: () => buildPingUrl("not a url", "session-1", token) },
      { source: "about:blank", run: () => buildPingUrl("about:blank", "session-1", token) },
      { source, run: () => buildPingUrl(source, "", token) },
      { source, run: () => buildPingUrl(source, "session-1", "") },
    ];

    for (const entry of runs) {
      let message = "";
      try {
        entry.run();
      } catch (err: unknown) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(token);
      expect(message).not.toContain("X-Plex-Token");
      expect(message).not.toContain(entry.source);
    }
  });
});

describe("pingTranscodeSession", () => {
  const url =
    "https://local.example.plex.direct:32400/video/:/transcode/universal/ping?session=session-1&X-Plex-Token=example-token";

  it("sends one cors request with no headers and reads the status", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(emptyHtml(200)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(pingTranscodeSession(url)).resolves.toBe("alive");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url, {
      mode: "cors",
      cache: "no-store",
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).not.toHaveProperty("headers");
  });

  it("returns dead for 404 and unknown for anything else, and never rejects", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(emptyHtml(404)));
    await expect(pingTranscodeSession(url)).resolves.toBe("dead");

    vi.stubGlobal("fetch", () => Promise.resolve(emptyHtml(500)));
    await expect(pingTranscodeSession(url)).resolves.toBe("unknown");

    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    await expect(pingTranscodeSession(url)).resolves.toBe("unknown");

    vi.stubGlobal("fetch", () => {
      throw new Error("sync boom");
    });
    await expect(pingTranscodeSession(url)).resolves.toBe("unknown");
  });
});
