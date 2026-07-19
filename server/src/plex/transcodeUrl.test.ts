import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHlsDecisionUrl, buildHlsUrl } from "./transcodeUrl";

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
    assert.equal(parsed.searchParams.get("path"), "/library/metadata/12345");
    assert.equal(parsed.searchParams.get("X-Plex-Token"), "transient-a-b-c");
  });
});
