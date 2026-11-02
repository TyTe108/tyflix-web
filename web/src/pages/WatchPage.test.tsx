// Redaction for Phase 37.0 HLS playback diagnostics. Stream URLs carry
// X-Plex-Token; the on-screen error and console.error payload must never leak
// it. Wording of the diagnostic message is deliberately not asserted — only
// that the secret is absent and the hostname remains.
//
// Also covers wantsFullscreenFromNavState and shouldEnterFullscreenOnMount:
// Play-navigation latches enterFullscreen, and the account preference gates
// whether that becomes enterFullscreenOnMount for PlayerControls.
import { describe, expect, it } from "vitest";
import { isLandingState } from "../lib/landing";
import {
  buildHlsPlaybackFailureReport,
  episodeSwitchState,
  shouldEnterFullscreenOnMount,
  wantsFullscreenFromNavState,
} from "./WatchPage";

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

describe("wantsFullscreenFromNavState", () => {
  it("is true only for { enterFullscreen: true }", () => {
    expect(wantsFullscreenFromNavState({ enterFullscreen: true })).toBe(true);
  });

  it("is false for null, undefined, primitives, and a non-boolean enterFullscreen", () => {
    expect(wantsFullscreenFromNavState(null)).toBe(false);
    expect(wantsFullscreenFromNavState(undefined)).toBe(false);
    expect(wantsFullscreenFromNavState("yes")).toBe(false);
    expect(wantsFullscreenFromNavState(1)).toBe(false);
    expect(wantsFullscreenFromNavState({ enterFullscreen: "yes" })).toBe(
      false,
    );
  });
});

describe("shouldEnterFullscreenOnMount", () => {
  it("is true when nav asks for fullscreen and the preference allows it", () => {
    expect(
      shouldEnterFullscreenOnMount({ enterFullscreen: true }, true),
    ).toBe(true);
  });

  it("is false when nav asks for fullscreen but the preference is off", () => {
    expect(
      shouldEnterFullscreenOnMount({ enterFullscreen: true }, false),
    ).toBe(false);
  });

  it("is false with no nav state even when the preference is on", () => {
    expect(shouldEnterFullscreenOnMount(null, true)).toBe(false);
    expect(shouldEnterFullscreenOnMount(undefined, true)).toBe(false);
  });
});

describe("episodeSwitchState", () => {
  it("is null when the entry is not a landing location and fullscreen is not requested", () => {
    expect(episodeSwitchState({ key: "abc", state: null }, false)).toBe(null);
    expect(
      episodeSwitchState(
        { key: "abc", state: { enterFullscreen: true } },
        false,
      ),
    ).toBe(null);
  });

  it("requests fullscreen without a landing marker when the entry is not a landing location", () => {
    const state = episodeSwitchState({ key: "abc", state: null }, true);
    expect(wantsFullscreenFromNavState(state)).toBe(true);
    expect(isLandingState(state)).toBe(false);
  });

  it("carries a landing marker without fullscreen when the entry opened the visit", () => {
    const fromDefaultKey = episodeSwitchState(
      { key: "default", state: { enterFullscreen: true } },
      false,
    );
    expect(isLandingState(fromDefaultKey)).toBe(true);
    expect(wantsFullscreenFromNavState(fromDefaultKey)).toBe(false);

    const fromMarker = episodeSwitchState(
      { key: "abc", state: { landing: true } },
      false,
    );
    expect(isLandingState(fromMarker)).toBe(true);
    expect(wantsFullscreenFromNavState(fromMarker)).toBe(false);
  });

  it("carries a landing marker and fullscreen when the entry opened the visit and fullscreen is requested", () => {
    const fromDefaultKey = episodeSwitchState(
      { key: "default", state: null },
      true,
    );
    expect(isLandingState(fromDefaultKey)).toBe(true);
    expect(wantsFullscreenFromNavState(fromDefaultKey)).toBe(true);

    const fromMarker = episodeSwitchState(
      { key: "abc", state: { landing: true } },
      true,
    );
    expect(isLandingState(fromMarker)).toBe(true);
    expect(wantsFullscreenFromNavState(fromMarker)).toBe(true);
  });

  it('is null for { landing: "yes" } on a key other than "default"', () => {
    expect(
      episodeSwitchState({ key: "abc", state: { landing: "yes" } }, false),
    ).toBe(null);
  });
});
