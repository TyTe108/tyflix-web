import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDashUrl, buildHlsDecisionUrl, buildHlsUrl } from "./transcodeUrl";

const PARAMS = {
  connectionUri: "https://1-2-3-4.abc123.plex.direct:32400",
  ratingKey: "12345",
  token: "transient-a-b-c",
  clientId: "client-id-1",
  sessionId: "sess-abc-123",
};

describe("buildHlsUrl", () => {
  it("builds the universal start.m3u8 base path", () => {
    const url = buildHlsUrl(PARAMS);
    assert.ok(
      url.startsWith(
        "https://1-2-3-4.abc123.plex.direct:32400/video/:/transcode/universal/start.m3u8?",
      ),
      `unexpected base path: ${url}`,
    );
  });

  it("strips a trailing slash from the connection URI", () => {
    const url = buildHlsUrl({
      ...PARAMS,
      connectionUri: "https://host:32400/",
    });
    assert.ok(
      url.startsWith(
        "https://host:32400/video/:/transcode/universal/start.m3u8?",
      ),
    );
  });

  it("includes the H.264-forcing transcode params", () => {
    const url = buildHlsUrl(PARAMS);
    const parsed = new URL(url);

    assert.equal(parsed.searchParams.get("protocol"), "hls");
    assert.equal(parsed.searchParams.get("directPlay"), "0");
    assert.equal(parsed.searchParams.get("directStream"), "1");
    assert.equal(parsed.searchParams.get("mediaIndex"), "0");
    assert.equal(parsed.searchParams.get("partIndex"), "0");
    assert.equal(parsed.searchParams.get("fastSeek"), "1");
    assert.equal(parsed.searchParams.get("subtitles"), "burn");
    assert.equal(parsed.searchParams.get("X-Plex-Platform"), "Chrome");

    const profileExtra =
      parsed.searchParams.get("X-Plex-Client-Profile-Extra") ?? "";
    assert.ok(profileExtra.includes("videoCodec=h264"));
    assert.ok(profileExtra.includes("audioCodec=aac"));
    assert.ok(profileExtra.includes("protocol=hls"));
  });

  it("carries the metadata path, token, client id, and session id", () => {
    const url = buildHlsUrl(PARAMS);
    const parsed = new URL(url);

    assert.equal(parsed.searchParams.get("path"), "/library/metadata/12345");
    assert.equal(parsed.searchParams.get("X-Plex-Token"), "transient-a-b-c");
    assert.equal(
      parsed.searchParams.get("X-Plex-Client-Identifier"),
      "client-id-1",
    );
    assert.equal(parsed.searchParams.get("session"), "sess-abc-123");
    assert.equal(
      parsed.searchParams.get("X-Plex-Session-Identifier"),
      "sess-abc-123",
    );
  });

  it("percent-encodes values in the raw query string", () => {
    const query = buildHlsUrl(PARAMS).split("?")[1];
    // The metadata path's slashes must be encoded, proving nothing is raw.
    assert.ok(query.includes("path=%2Flibrary%2Fmetadata%2F12345"));
    // The profile-extra parens/ampersands must be encoded too.
    assert.ok(query.includes("X-Plex-Client-Profile-Extra=add-transcode-target%28"));
  });

  it("omits optional tuning params when none are provided", () => {
    const parsed = new URL(buildHlsUrl(PARAMS));
    assert.equal(parsed.searchParams.get("maxVideoBitrate"), null);
    assert.equal(parsed.searchParams.get("videoResolution"), null);
    assert.equal(parsed.searchParams.get("audioStreamID"), null);
    assert.equal(parsed.searchParams.get("subtitleStreamID"), null);
    assert.equal(parsed.searchParams.get("offset"), null);
    // Burn-ready is fixed, not optional — always present even with no tuning.
    assert.equal(parsed.searchParams.get("subtitles"), "burn");
  });

  it("emits maxVideoBitrate when provided", () => {
    const parsed = new URL(
      buildHlsUrl({ ...PARAMS, maxVideoBitrate: 4000 }),
    );
    assert.equal(parsed.searchParams.get("maxVideoBitrate"), "4000");
  });

  it("emits videoResolution when provided", () => {
    const parsed = new URL(
      buildHlsUrl({ ...PARAMS, videoResolution: "1280x720" }),
    );
    assert.equal(parsed.searchParams.get("videoResolution"), "1280x720");
  });

  it("emits audioStreamID when provided", () => {
    const parsed = new URL(
      buildHlsUrl({ ...PARAMS, audioStreamID: "101" }),
    );
    assert.equal(parsed.searchParams.get("audioStreamID"), "101");
  });

  it("emits subtitleStreamID when provided", () => {
    const parsed = new URL(
      buildHlsUrl({ ...PARAMS, subtitleStreamID: "102" }),
    );
    assert.equal(parsed.searchParams.get("subtitleStreamID"), "102");
  });

  it("emits offset when provided", () => {
    const parsed = new URL(buildHlsUrl({ ...PARAMS, offset: 90.5 }));
    assert.equal(parsed.searchParams.get("offset"), "90.5");
  });

  it("throws on invalid optional tuning params", () => {
    assert.throws(
      () => buildHlsUrl({ ...PARAMS, maxVideoBitrate: 0 }),
      /maxVideoBitrate/,
    );
    assert.throws(
      () => buildHlsUrl({ ...PARAMS, maxVideoBitrate: -1 }),
      /maxVideoBitrate/,
    );
    assert.throws(
      () => buildHlsUrl({ ...PARAMS, maxVideoBitrate: 1.5 }),
      /maxVideoBitrate/,
    );
    assert.throws(
      () => buildHlsUrl({ ...PARAMS, offset: -1 }),
      /offset/,
    );
    assert.throws(
      () => buildHlsUrl({ ...PARAMS, videoResolution: "720p" }),
      /videoResolution/,
    );
    assert.throws(
      () => buildHlsUrl({ ...PARAMS, audioStreamID: "   " }),
      /audioStreamID/,
    );
    assert.throws(
      () => buildHlsUrl({ ...PARAMS, subtitleStreamID: "" }),
      /subtitleStreamID/,
    );
  });
});

describe("buildHlsDecisionUrl", () => {
  it("swaps the start.m3u8 segment for decision, keeping the params", () => {
    const url = buildHlsDecisionUrl(PARAMS);
    assert.ok(
      url.startsWith(
        "https://1-2-3-4.abc123.plex.direct:32400/video/:/transcode/universal/decision?",
      ),
      `unexpected decision path: ${url}`,
    );

    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("protocol"), "hls");
    assert.equal(parsed.searchParams.get("directPlay"), "0");
    assert.equal(parsed.searchParams.get("subtitles"), "burn");
    assert.equal(parsed.searchParams.get("path"), "/library/metadata/12345");
    assert.equal(parsed.searchParams.get("X-Plex-Token"), "transient-a-b-c");
  });
});

describe("buildDashUrl", () => {
  it("builds the universal start.mpd base path", () => {
    const url = buildDashUrl(PARAMS);
    assert.ok(
      url.startsWith(
        "https://1-2-3-4.abc123.plex.direct:32400/video/:/transcode/universal/start.mpd?",
      ),
      `unexpected base path: ${url}`,
    );
  });

  it("strips a trailing slash from the connection URI", () => {
    const url = buildDashUrl({
      ...PARAMS,
      connectionUri: "https://host:32400/",
    });
    assert.ok(
      url.startsWith(
        "https://host:32400/video/:/transcode/universal/start.mpd?",
      ),
    );
  });

  it("uses protocol=dash and the verified DASH profile-extra", () => {
    const url = buildDashUrl(PARAMS);
    const parsed = new URL(url);

    assert.equal(parsed.searchParams.get("protocol"), "dash");
    assert.equal(parsed.searchParams.get("directPlay"), "0");
    assert.equal(parsed.searchParams.get("directStream"), "1");
    assert.equal(parsed.searchParams.get("mediaIndex"), "0");
    assert.equal(parsed.searchParams.get("partIndex"), "0");
    assert.equal(parsed.searchParams.get("fastSeek"), "1");
    assert.equal(parsed.searchParams.get("subtitles"), "burn");
    assert.equal(parsed.searchParams.get("videoCodec"), "h264");
    assert.equal(parsed.searchParams.get("audioCodec"), "aac");
    assert.equal(parsed.searchParams.get("X-Plex-Platform"), "Chrome");

    assert.equal(
      parsed.searchParams.get("X-Plex-Client-Profile-Extra"),
      "add-transcode-target(type=videoProfile&context=streaming&protocol=dash&container=mpegts&videoCodec=h264&audioCodec=aac)",
    );
  });

  it("matches the HLS baseline for path, token, client id, and session id", () => {
    const url = buildDashUrl(PARAMS);
    const parsed = new URL(url);

    assert.equal(parsed.searchParams.get("path"), "/library/metadata/12345");
    assert.equal(parsed.searchParams.get("X-Plex-Token"), "transient-a-b-c");
    assert.equal(
      parsed.searchParams.get("X-Plex-Client-Identifier"),
      "client-id-1",
    );
    assert.equal(parsed.searchParams.get("session"), "sess-abc-123");
    assert.equal(
      parsed.searchParams.get("X-Plex-Session-Identifier"),
      "sess-abc-123",
    );
  });

  it("percent-encodes values in the raw query string", () => {
    const query = buildDashUrl(PARAMS).split("?")[1];
    assert.ok(query.includes("path=%2Flibrary%2Fmetadata%2F12345"));
    assert.ok(
      query.includes("X-Plex-Client-Profile-Extra=add-transcode-target%28"),
    );
  });

  it("omits optional tuning params when none are provided", () => {
    const parsed = new URL(buildDashUrl(PARAMS));
    assert.equal(parsed.searchParams.get("maxVideoBitrate"), null);
    assert.equal(parsed.searchParams.get("videoResolution"), null);
    assert.equal(parsed.searchParams.get("audioStreamID"), null);
    assert.equal(parsed.searchParams.get("subtitleStreamID"), null);
    assert.equal(parsed.searchParams.get("offset"), null);
    assert.equal(parsed.searchParams.get("subtitles"), "burn");
  });

  it("emits the same optional tuning params as the HLS builder", () => {
    const tuned = {
      ...PARAMS,
      maxVideoBitrate: 4000,
      videoResolution: "1280x720",
      audioStreamID: "101",
      subtitleStreamID: "102",
      offset: 90.5,
    };
    const parsed = new URL(buildDashUrl(tuned));
    assert.equal(parsed.searchParams.get("maxVideoBitrate"), "4000");
    assert.equal(parsed.searchParams.get("videoResolution"), "1280x720");
    assert.equal(parsed.searchParams.get("audioStreamID"), "101");
    assert.equal(parsed.searchParams.get("subtitleStreamID"), "102");
    assert.equal(parsed.searchParams.get("offset"), "90.5");
  });

  it("throws on invalid optional tuning params", () => {
    assert.throws(
      () => buildDashUrl({ ...PARAMS, maxVideoBitrate: 0 }),
      /maxVideoBitrate/,
    );
    assert.throws(
      () => buildDashUrl({ ...PARAMS, videoResolution: "720p" }),
      /videoResolution/,
    );
    assert.throws(
      () => buildDashUrl({ ...PARAMS, audioStreamID: "   " }),
      /audioStreamID/,
    );
    assert.throws(() => buildDashUrl({ ...PARAMS, offset: -1 }), /offset/);
  });

  it("differs from HLS only in path, protocol, and profile-extra", () => {
    const hls = new URL(buildHlsUrl(PARAMS));
    const dash = new URL(buildDashUrl(PARAMS));

    assert.ok(hls.pathname.endsWith("/start.m3u8"));
    assert.ok(dash.pathname.endsWith("/start.mpd"));
    assert.equal(hls.searchParams.get("protocol"), "hls");
    assert.equal(dash.searchParams.get("protocol"), "dash");

    const hlsKeys = [...hls.searchParams.keys()].sort();
    const dashKeys = [...dash.searchParams.keys()].sort();
    assert.deepEqual(hlsKeys, dashKeys);

    for (const key of hlsKeys) {
      if (key === "protocol" || key === "X-Plex-Client-Profile-Extra") {
        continue;
      }
      assert.equal(
        dash.searchParams.get(key),
        hls.searchParams.get(key),
        `param ${key} should match HLS baseline`,
      );
    }
  });
});
