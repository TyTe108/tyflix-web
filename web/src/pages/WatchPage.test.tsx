// Redaction for Phase 37.0 HLS playback diagnostics. Stream URLs carry
// X-Plex-Token; the on-screen error and console.error payload must never leak
// it. Wording of the diagnostic message is deliberately not asserted — only
// that the secret is absent and the hostname remains.
import { describe, expect, it } from "vitest";
import { buildHlsPlaybackFailureReport } from "./WatchPage";

const HOST = "1-2-3.12345.plex.direct";
const SECRET = "SECRETVALUE";
const STREAM_URL =
  `https://${HOST}:32400/video/:/transcode/universal/start.m3u8` +
  `?X-Plex-Token=${SECRET}&session=abc123`;

describe("HLS playback failure diagnostics", () => {
  it("redacts X-Plex-Token from the on-screen message and console.error payload", () => {
    const report = buildHlsPlaybackFailureReport({
      hadLocalUrl: true,
      attempts: [
        {
          connection: "local",
          sourceUrl: STREAM_URL,
          data: {
            type: "networkError",
            details: "manifestLoadError",
            fatal: true,
            url: STREAM_URL,
            response: {
              url: STREAM_URL,
              code: 403,
              text: "Forbidden",
            },
          },
        },
        {
          connection: "remote",
          sourceUrl: STREAM_URL,
          data: {
            type: "networkError",
            details: "manifestLoadError",
            fatal: true,
            url: STREAM_URL,
            response: {
              code: 0,
              text: "",
            },
          },
        },
      ],
    });

    expect(report.message).not.toContain(SECRET);
    expect(JSON.stringify(report.logPayload)).not.toContain(SECRET);
    expect(report.message).toContain(HOST);
    expect(JSON.stringify(report.logPayload)).toContain(HOST);
  });
});
