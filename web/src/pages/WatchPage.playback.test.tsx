// Characterization tests for WatchPage playback. They render the page with
// the fake hls.js and the fake media element and pin the behavior phase 56
// has to keep: local then remote attach, the resume dialog, a quality switch,
// timeline reports, cast teardown, episode changes, and one live Hls instance
// under StrictMode.
//
// hls.js, the watch API, cast, and auth are mocked here. global fetch throws
// so a call that misses those mocks fails the test.

import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEpisodeWatch, fetchNextEpisode, reportTimeline, reportTimelineBeacon } from "../api/watch";
import FakeHls, { emit, hlsInstances, resetFakeHls } from "../test/fakeHls";
import {
  fireMediaEvent,
  installFakeMedia,
  mediaCalls,
  restoreFakeMedia,
  setMediaCurrentTime,
  setMediaReadyState,
} from "../test/fakeMedia";
import {
  buildWatchDescriptor,
  installWatchFetchMocks,
  renderWatchPage,
  resolveLatestEpisodeWatch,
  type WatchDescriptorOptions,
} from "../test/renderWatchPage";
import type { WatchDescriptor } from "../api/watch";

const castStore = vi.hoisted(() => {
  let connected = false;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot() {
      return connected;
    },
    setConnected(next: boolean) {
      connected = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
});

const idleCastPlayer = vi.hoisted(() => ({
  isActive: false,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  deviceName: null as string | null,
  playOrPause: () => {},
  seek: () => {},
  setVolumeLevel: () => {},
  muteOrUnmute: () => {},
}));

vi.mock("hls.js", async () => {
  const fake = await import("../test/fakeHls");
  return { default: fake.default };
});

vi.mock("../api/watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/watch")>();
  return {
    ...actual,
    fetchEpisodeWatch: vi.fn(),
    fetchItemWatch: vi.fn(),
    fetchMovieWatch: vi.fn(),
    fetchNextEpisode: vi.fn(),
    fetchPreviousEpisode: vi.fn(),
    selectSubtitle: vi.fn(),
    selectAudio: vi.fn(),
    reportTimeline: vi.fn(),
    reportTimelineBeacon: vi.fn(),
  };
});

vi.mock("../cast/useCastState", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useCastState: () => {
      const connected = useSyncExternalStore(
        castStore.subscribe,
        castStore.snapshot,
        castStore.snapshot,
      );
      return {
        available: false,
        connected,
        toggle: () => {},
      };
    },
  };
});

vi.mock("../cast/useCastPlayer", () => ({
  useCastPlayer: () => idleCastPlayer,
}));

vi.mock("../cast/subscribeSessionReady", () => ({
  subscribeSessionReady: () => () => {},
}));

vi.mock("../cast/loadMediaOnCast", () => ({
  loadMediaOnCast: vi.fn(),
}));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    preferences: { fullscreenOnPlay: false },
  }),
}));

function stubFetch(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    throw new Error(`unexpected network fetch: ${target}`);
  });
}

function watchVideo(): HTMLVideoElement {
  const video = document.querySelector("video.watch-player");
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error("watch video is missing");
  }
  return video;
}

function liveInstances(): FakeHls[] {
  return hlsInstances.filter((item) => !item.destroyed);
}

async function startPlayback(options?: {
  descriptor?: WatchDescriptor;
  descriptorOptions?: WatchDescriptorOptions;
  strict?: boolean;
}): Promise<{
  descriptor: WatchDescriptor;
  video: HTMLVideoElement;
  hls: FakeHls;
  unmount: () => void;
}> {
  const descriptor =
    options?.descriptor ?? buildWatchDescriptor(options?.descriptorOptions);
  const view = renderWatchPage({
    ratingKey: descriptor.ratingKey,
    strict: options?.strict,
  });
  await resolveLatestEpisodeWatch(descriptor);
  await waitFor(() => {
    expect(liveInstances().length).toBeGreaterThan(0);
  });
  const hls = liveInstances().at(-1);
  if (hls === undefined) {
    throw new Error("live Hls instance is missing");
  }
  return { descriptor, video: watchVideo(), hls, unmount: view.unmount };
}

function fatalManifestTimeout(url: string) {
  return {
    type: FakeHls.ErrorTypes.NETWORK_ERROR,
    details: FakeHls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
    fatal: true,
    url,
    reason: "timeout",
    error: new Error("manifest load timed out"),
    response: { url, data: undefined, code: 0, text: "" },
  };
}

function requireLocalUrl(descriptor: WatchDescriptor): string {
  const url = descriptor.hls.local;
  if (url === null) {
    throw new Error("expected a local URL");
  }
  return url;
}

function playingReports(): number {
  return vi
    .mocked(reportTimeline)
    .mock.calls.filter((call) => call[0].state === "playing").length;
}

function setCastConnected(connected: boolean): void {
  act(() => {
    castStore.setConnected(connected);
  });
}

// Phase 56.1 helpers. They are used by the timeline tests at the end of the
// describe block below.

// Every payload sent through reportTimeline so far, in order.
function timelineCalls() {
  return vi.mocked(reportTimeline).mock.calls.map((call) => call[0]);
}

// Every payload sent through reportTimelineBeacon so far, in order.
function beaconCalls() {
  return vi.mocked(reportTimelineBeacon).mock.calls.map((call) => call[0]);
}

// Fakes only the interval timers, so the heartbeat is under test control while
// promises, waitFor and the page's own timeouts keep running on real time.
// Call it before the stream plays, because the heartbeat is created at that
// moment. The afterEach hook of the describe block restores real timers.
function useHeartbeatClock(): void {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
}

function advanceClock(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

// The manifest parses, then the viewer is at this position and the element
// reports it: a timeupdate, then playing, the way a browser orders them.
function startPlayingAt(
  hls: FakeHls,
  video: HTMLVideoElement,
  seconds: number,
): void {
  act(() => {
    emit(hls, FakeHls.Events.MANIFEST_PARSED, {});
  });
  setMediaCurrentTime(video, seconds);
  act(() => {
    fireMediaEvent(video, "timeupdate");
    fireMediaEvent(video, "playing");
  });
}

// The ErrorData hls.js builds for a fragment that fails on a dead session
// (src/loader/fragment-loader.ts 113-127, copied into dist/hls.mjs 5817-5828).
// The fields WatchPage reads are here. The rest (frag, networkDetails, stats,
// errorAction) are left out because WatchPage does not read them.
function fragLoadError(
  url: string,
  code: number,
  text: string,
  fatal: boolean,
) {
  return {
    type: FakeHls.ErrorTypes.NETWORK_ERROR,
    details: FakeHls.ErrorDetails.FRAG_LOAD_ERROR,
    fatal,
    response: { url, data: undefined, code, text },
    error: new Error(`HTTP Error ${code} ${text}`),
  };
}

// Six retried failures that hls.js reports as not fatal, then the seventh as
// fatal (spec E3). In a browser they arrive over about 31 s (1, 2, 4, 8, 8
// and 8 s apart). These tests emit them together because only their order
// matters here.
function failFragments(
  hls: FakeHls,
  descriptor: WatchDescriptor,
  code: number,
  text: string,
): void {
  const segmentUrl = `${new URL(descriptor.hls.remote).origin}/video/:/transcode/universal/session/${descriptor.sessionId}/base/00042.ts?X-Plex-Token=${descriptor.transient}`;
  act(() => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      emit(hls, FakeHls.Events.ERROR, fragLoadError(segmentUrl, code, text, false));
    }
    emit(hls, FakeHls.Events.ERROR, fragLoadError(segmentUrl, code, text, true));
  });
}

// The off-LAN viewer of spec E4: no local URL, so the stream is on the remote
// connection. It plays to 397.6 s with the heartbeat running, then a fatal
// fragLoadError arrives. Returns once the page shows the error state.
async function failRemoteStream(
  code: number,
  text: string,
): Promise<{
  descriptor: WatchDescriptor;
  video: HTMLVideoElement;
  unmount: () => void;
  reportsBeforeFailure: number;
}> {
  const descriptor = buildWatchDescriptor({ local: null });
  const { video, hls, unmount } = await startPlayback({ descriptor });
  useHeartbeatClock();
  startPlayingAt(hls, video, 397.6);
  advanceClock(10_000);
  // The heartbeat was running and reporting the real position.
  expect(timelineCalls().map((call) => call.time)).toEqual([397_600, 397_600]);
  const reportsBeforeFailure = timelineCalls().length;

  failFragments(hls, descriptor, code, text);

  expect(hls.destroyed).toBe(true);
  expect(video.currentTime).toBe(0);
  expect(video.isConnected).toBe(false);
  expect(document.querySelector(".watch-playback-diag")).not.toBeNull();
  return { descriptor, video, unmount, reportsBeforeFailure };
}

// document.visibilityState is read at event time, so a test sets it for the
// length of one callback and then removes the override.
function withHiddenDocument(run: () => void): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  try {
    run();
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
}

describe("WatchPage playback", () => {
  beforeEach(() => {
    localStorage.clear();
    resetFakeHls();
    installFakeMedia();
    castStore.setConnected(false);
    installWatchFetchMocks();
    stubFetch();
  });

  afterEach(() => {
    try {
      cleanup();
    } finally {
      restoreFakeMedia();
      vi.unstubAllGlobals();
      vi.useRealTimers();
      localStorage.clear();
    }
  });

  it("loads the local URL into the page video with the 3s manifest fast-fail", async () => {
    const { descriptor, video, hls } = await startPlayback();

    expect(hlsInstances).toHaveLength(1);
    expect(hls.url).toBe(requireLocalUrl(descriptor));
    expect(hls.media).toBe(video);
    expect(hls.destroyed).toBe(false);
    expect(hls.config).toEqual({
      enableWorker: false,
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 3000,
          maxLoadTimeMs: 3000,
          timeoutRetry: {
            maxNumRetry: 0,
            retryDelayMs: 0,
            maxRetryDelayMs: 0,
          },
          errorRetry: {
            maxNumRetry: 0,
            retryDelayMs: 0,
            maxRetryDelayMs: 0,
          },
        },
      },
    });
  });

  it("falls back to the remote URL after a fatal local manifest timeout", async () => {
    const { descriptor, video, hls } = await startPlayback();
    const localUrl = requireLocalUrl(descriptor);

    emit(hls, FakeHls.Events.ERROR, fatalManifestTimeout(localUrl));

    expect(hls.destroyed).toBe(true);
    expect(hlsInstances).toHaveLength(2);
    const remote = hlsInstances[1];
    expect(remote).toBeDefined();
    expect(remote?.destroyed).toBe(false);
    expect(remote?.url).toBe(descriptor.hls.remote);
    expect(remote?.media).toBe(video);
    expect(remote?.config).toEqual({ enableWorker: false });
  });

  it("shows the connection failure after fatal errors on local and remote", async () => {
    const { descriptor, hls } = await startPlayback();
    const localUrl = requireLocalUrl(descriptor);

    act(() => {
      emit(hls, FakeHls.Events.ERROR, fatalManifestTimeout(localUrl));
    });
    const remote = hlsInstances[1];
    if (remote === undefined) {
      throw new Error("remote Hls instance is missing");
    }
    // No fragment event is emitted. This is the failure before any fragment
    // has buffered, which today ends in the error state.
    act(() => {
      emit(
        remote,
        FakeHls.Events.ERROR,
        fatalManifestTimeout(descriptor.hls.remote),
      );
    });

    const diag = document.querySelector(".watch-playback-diag");
    if (!(diag instanceof HTMLElement) || diag.textContent === null) {
      throw new Error("playback error text is missing");
    }
    expect(diag.textContent.startsWith("Playback failed on all connections.")).toBe(
      true,
    );
    expect(diag.textContent).toContain(new URL(descriptor.hls.remote).hostname);
    expect(diag.textContent).not.toContain(descriptor.transient);
    expect(document.querySelector("video.watch-player")).toBeNull();
  });

  it("loads the remote URL when the descriptor has no local URL", async () => {
    const descriptor = buildWatchDescriptor({ local: null });
    const { video, hls } = await startPlayback({ descriptor });

    expect(hlsInstances).toHaveLength(1);
    expect(hls.url).toBe(descriptor.hls.remote);
    expect(hls.media).toBe(video);
    expect(hls.config).toEqual({ enableWorker: false });
  });

  it("plays when the manifest parses with no parked seek and no Resume dialog", async () => {
    const { video, hls } = await startPlayback();

    expect(screen.queryByRole("dialog")).toBeNull();
    emit(hls, FakeHls.Events.MANIFEST_PARSED, {});

    expect(mediaCalls(video).play).toBe(1);
    expect(video.paused).toBe(false);
  });

  it("shows the Resume dialog and seeks to the saved position when Resume is chosen", async () => {
    const descriptor = buildWatchDescriptor({ viewOffsetMs: 125_000 });
    const { video, hls } = await startPlayback({ descriptor });

    expect(screen.getByRole("dialog", { name: /Resume from 2:05/ })).toBeTruthy();
    const before = mediaCalls(video);
    emit(hls, FakeHls.Events.MANIFEST_PARSED, {});
    const afterManifest = mediaCalls(video);
    expect(afterManifest.play).toBe(before.play);
    expect(afterManifest.pause).toBe(before.pause + 1);
    expect(video.paused).toBe(true);

    setMediaReadyState(video, HTMLMediaElement.HAVE_METADATA);
    fireEvent.click(screen.getByRole("button", { name: /^Resume$/ }));

    expect(video.currentTime).toBe(125);
    expect(mediaCalls(video).play).toBe(afterManifest.play + 1);
    expect(video.paused).toBe(false);
  });

  it("switches to 720p on the same video and resumes at the parked time", async () => {
    const { descriptor, video, hls } = await startPlayback();
    setMediaCurrentTime(video, 1200);
    await act(async () => {
      await video.play();
    });
    const playsBeforeSwitch = mediaCalls(video).play;

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Quality/ }));
    fireEvent.click(screen.getByRole("button", { name: "720p" }));

    expect(vi.mocked(fetchEpisodeWatch)).toHaveBeenLastCalledWith(descriptor.ratingKey, {
      maxVideoBitrate: 4000,
      videoResolution: "1280x720",
    });
    expect(screen.queryByText(/Loading stream/)).toBeNull();
    expect(screen.queryByText(/Playback failed/)).toBeNull();
    expect(video.isConnected).toBe(true);
    expect(hls.destroyed).toBe(false);

    const switched = buildWatchDescriptor({
      ratingKey: descriptor.ratingKey,
      sessionId: "session-example-2",
      token: "example-token-57",
    });
    const switchedUrl = requireLocalUrl(switched);
    await resolveLatestEpisodeWatch(switched);

    expect(hls.destroyed).toBe(true);
    const live = liveInstances();
    expect(live).toHaveLength(1);
    expect(live[0]?.url).toBe(switchedUrl);
    expect(live[0]?.media).toBe(video);
    expect(screen.queryByText(/Loading stream/)).toBeNull();
    expect(screen.queryByText(/Playback failed/)).toBeNull();
    expect(video.isConnected).toBe(true);

    const next = live[0];
    if (next === undefined) {
      throw new Error("switched Hls instance is missing");
    }
    emit(next, FakeHls.Events.MANIFEST_PARSED, {});

    expect(video.currentTime).toBe(1200);
    expect(video.paused).toBe(false);
    expect(mediaCalls(video).play).toBe(playsBeforeSwitch + 1);
    expect(screen.queryByText(/Loading stream/)).toBeNull();
    expect(screen.queryByText(/Playback failed/)).toBeNull();
  });

  it("reports timeline positions while playing and one stopped beacon on pagehide", async () => {
    const { descriptor, video, unmount } = await startPlayback();
    if (descriptor.durationMs === null) {
      throw new Error("descriptor duration is missing");
    }
    const duration = descriptor.durationMs;
    setMediaCurrentTime(video, 42.5);
    vi.useFakeTimers();
    try {
      expect(vi.mocked(reportTimeline)).not.toHaveBeenCalled();
      await act(async () => {
        await video.play();
      });
      expect(vi.mocked(reportTimeline)).not.toHaveBeenCalled();

      act(() => {
        fireMediaEvent(video, "playing");
      });
      expect(vi.mocked(reportTimeline)).toHaveBeenLastCalledWith({
        ratingKey: descriptor.ratingKey,
        state: "playing",
        time: 42_500,
        duration,
      });
      expect(playingReports()).toBe(1);

      act(() => {
        vi.advanceTimersByTime(9_999);
      });
      expect(playingReports()).toBe(1);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(playingReports()).toBe(2);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(playingReports()).toBe(3);

      act(() => {
        video.pause();
      });
      expect(vi.mocked(reportTimeline)).toHaveBeenLastCalledWith({
        ratingKey: descriptor.ratingKey,
        state: "paused",
        time: 42_500,
        duration,
      });
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(playingReports()).toBe(3);

      act(() => {
        fireMediaEvent(video, "ended");
      });
      expect(vi.mocked(reportTimeline)).toHaveBeenLastCalledWith({
        ratingKey: descriptor.ratingKey,
        state: "stopped",
        time: 42_500,
        duration,
      });
      expect(vi.mocked(reportTimelineBeacon)).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(vi.mocked(reportTimelineBeacon)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reportTimelineBeacon)).toHaveBeenCalledWith({
        ratingKey: descriptor.ratingKey,
        state: "stopped",
        time: 42_500,
        duration,
      });

      act(() => {
        unmount();
      });
      expect(vi.mocked(reportTimelineBeacon)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops local playback when Cast connects and sends no timeline report", async () => {
    const { descriptor, video, hls } = await startPlayback();
    // The fake never assigns a blob URL, so plant one. Tear-down has to remove it.
    video.setAttribute("src", requireLocalUrl(descriptor));

    setCastConnected(true);

    expect(hls.destroyed).toBe(true);
    expect(liveInstances()).toHaveLength(0);
    expect(video.getAttribute("src")).toBeNull();
    expect(vi.mocked(reportTimeline)).not.toHaveBeenCalled();
    expect(vi.mocked(reportTimelineBeacon)).not.toHaveBeenCalled();
  });

  it("destroys playback and fetches the next episode on navigation", async () => {
    vi.mocked(fetchNextEpisode).mockResolvedValue({
      ratingKey: "900002",
      seasonNumber: 1,
      episodeNumber: 2,
      title: "Second Example",
      thumb: null,
    });
    const { hls } = await startPlayback();
    const link = await screen.findByRole("link", { name: /Next episode/ });

    fireEvent.click(link);

    expect(hls.destroyed).toBe(true);
    expect(vi.mocked(fetchEpisodeWatch)).toHaveBeenCalledWith("900002");

    const next = buildWatchDescriptor({
      ratingKey: "900002",
      sessionId: "session-example-2",
      token: "example-token-57",
    });
    await resolveLatestEpisodeWatch(next);
    await waitFor(() => {
      expect(liveInstances().some((item) => item.url === next.hls.local)).toBe(true);
    });
  });

  it("keeps a single live Hls instance under StrictMode", async () => {
    const { descriptor, video } = await startPlayback({ strict: true });
    const alive = liveInstances();

    expect(alive).toHaveLength(1);
    expect(alive[0]?.url).toBe(requireLocalUrl(descriptor));
    expect(alive[0]?.media).toBe(video);
  });

  it("throws when an event is emitted on a destroyed Hls instance", () => {
    const hls = new FakeHls();
    hls.destroy();

    expect(() => {
      emit(hls, FakeHls.Events.ERROR, { fatal: true });
    }).toThrow(/destroyed Hls instance/);
  });

  // Phase 56.1: every local timeline report carries a real position or nothing.

  it("sends no report for 60 s after a fatal fragLoadError with code 0 on the remote URL", async () => {
    const { reportsBeforeFailure } = await failRemoteStream(0, "");

    advanceClock(60_000);

    expect(timelineCalls().slice(reportsBeforeFailure)).toEqual([]);
    expect(beaconCalls()).toEqual([]);
  });

  it("sends no report for 60 s after a fatal fragLoadError with code 404 on the remote URL", async () => {
    const { reportsBeforeFailure } = await failRemoteStream(404, "Not Found");

    advanceClock(60_000);

    expect(timelineCalls().slice(reportsBeforeFailure)).toEqual([]);
    expect(beaconCalls()).toEqual([]);
  });

  it("beacons the last real position when the tab hides and the page leaves after a fatal error", async () => {
    const { descriptor, unmount } = await failRemoteStream(0, "");

    withHiddenDocument(() => {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
    });
    expect(beaconCalls()).toEqual([
      {
        ratingKey: descriptor.ratingKey,
        state: "paused",
        time: 397_600,
        duration: 7_200_000,
      },
    ]);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    const stopped = {
      ratingKey: descriptor.ratingKey,
      state: "stopped",
      time: 397_600,
      duration: 7_200_000,
    };
    expect(beaconCalls()).toHaveLength(2);
    expect(beaconCalls().filter((payload) => payload.state === "stopped")).toEqual([
      stopped,
    ]);

    act(() => {
      unmount();
    });
    expect(beaconCalls().filter((payload) => payload.state === "stopped")).toEqual([
      stopped,
    ]);
  });

  it("sends nothing when the page is left with the Resume dialog open", async () => {
    const descriptor = buildWatchDescriptor({ viewOffsetMs: 125_000 });
    const { hls, unmount } = await startPlayback({ descriptor });
    expect(screen.getByRole("dialog", { name: /Resume from 2:05/ })).toBeTruthy();
    act(() => {
      emit(hls, FakeHls.Events.MANIFEST_PARSED, {});
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      act(() => {
        unmount();
      });
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });

      expect(timelineCalls()).toEqual([]);
      expect(beaconCalls()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain("stopped");
      expect(message).toContain("no playback position was known");
      expect(message).not.toContain("http");
      expect(message).not.toContain("plex.direct");
      expect(message).not.toContain(descriptor.transient);
      expect(message).not.toContain(descriptor.sessionId);
    } finally {
      warn.mockRestore();
    }
  });

  it("sends no heartbeat at 0 between the teardown and the manifest of a Quality switch", async () => {
    const { descriptor, video, hls } = await startPlayback();
    useHeartbeatClock();
    startPlayingAt(hls, video, 1200);
    expect(timelineCalls().map((call) => call.time)).toEqual([1_200_000]);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Quality/ }));
    fireEvent.click(screen.getByRole("button", { name: "720p" }));
    await resolveLatestEpisodeWatch(
      buildWatchDescriptor({
        ratingKey: descriptor.ratingKey,
        sessionId: "session-example-2",
        token: "example-token-57",
      }),
    );

    // The old instance is destroyed, the element reads 0, and the new
    // instance has not parsed its manifest yet.
    expect(hls.destroyed).toBe(true);
    expect(video.currentTime).toBe(0);
    const reportsAtTeardown = timelineCalls().length;
    advanceClock(10_000);
    expect(timelineCalls().slice(reportsAtTeardown)).toEqual([]);

    const next = liveInstances()[0];
    if (next === undefined) {
      throw new Error("switched Hls instance is missing");
    }
    act(() => {
      emit(next, FakeHls.Events.MANIFEST_PARSED, {});
    });
    act(() => {
      fireMediaEvent(video, "playing");
    });
    setMediaCurrentTime(video, 1210);
    advanceClock(10_000);

    expect(timelineCalls().slice(reportsAtTeardown).map((call) => call.time)).toEqual([
      1_200_000, 1_210_000,
    ]);
    expect(timelineCalls().filter((call) => call.time === 0)).toEqual([]);
  });

  it("beacons the receiver position when the page is left after a Cast handoff", async () => {
    const { descriptor, video, hls } = await startPlayback();
    startPlayingAt(hls, video, 300);

    try {
      // The receiver plays at 2000 s while Cast is connected.
      idleCastPlayer.isActive = true;
      idleCastPlayer.playing = true;
      idleCastPlayer.currentTime = 2000;
      setCastConnected(true);
      expect(hls.destroyed).toBe(true);

      // Cast disconnects and the receiver reads 0. The local stream has been
      // attached again and has not played.
      idleCastPlayer.isActive = false;
      idleCastPlayer.playing = false;
      idleCastPlayer.currentTime = 0;
      setCastConnected(false);
      expect(liveInstances()).toHaveLength(1);
      expect(video.currentTime).toBe(0);

      vi.mocked(reportTimelineBeacon).mockClear();
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
      });

      expect(beaconCalls()).toEqual([
        {
          ratingKey: descriptor.ratingKey,
          state: "stopped",
          time: 2_000_000,
          duration: 7_200_000,
        },
      ]);
    } finally {
      idleCastPlayer.isActive = false;
      idleCastPlayer.playing = false;
      idleCastPlayer.currentTime = 0;
    }
  });

  it("skips the playing report at 0 after Start over and reports at the first heartbeat", async () => {
    const descriptor = buildWatchDescriptor({ viewOffsetMs: 125_000 });
    const { video, hls } = await startPlayback({ descriptor });
    act(() => {
      emit(hls, FakeHls.Events.MANIFEST_PARSED, {});
    });
    setMediaReadyState(video, HTMLMediaElement.HAVE_METADATA);
    useHeartbeatClock();

    fireEvent.click(screen.getByRole("button", { name: /Start from the beginning/ }));
    expect(video.currentTime).toBe(0);
    act(() => {
      fireMediaEvent(video, "playing");
    });
    expect(timelineCalls()).toEqual([]);

    setMediaCurrentTime(video, 10);
    advanceClock(10_000);

    expect(timelineCalls()).toEqual([
      {
        ratingKey: descriptor.ratingKey,
        state: "playing",
        time: 10_000,
        duration: 7_200_000,
      },
    ]);
  });

  it("beacons the position from a timeupdate after a fatal error", async () => {
    const descriptor = buildWatchDescriptor({ local: null });
    const { video, hls } = await startPlayback({ descriptor });
    startPlayingAt(hls, video, 397.6);

    setMediaCurrentTime(video, 452.3);
    act(() => {
      fireMediaEvent(video, "timeupdate");
    });
    failFragments(hls, descriptor, 0, "");

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(beaconCalls()).toEqual([
      {
        ratingKey: descriptor.ratingKey,
        state: "stopped",
        time: 452_300,
        duration: 7_200_000,
      },
    ]);
  });
});
