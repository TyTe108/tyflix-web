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
  resolveLatestEpisodeWatchThen,
  resolvePendingEpisodeWatchFor,
  rejectPendingEpisodeWatchFor,
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

// Phase 56.2 helpers. They are used by the recovery tests at the end of the
// describe block below.

function fetchCalls() {
  return vi.mocked(fetchEpisodeWatch).mock.calls;
}

// Fakes the timers a recovery uses: its delay timer, the heartbeat, and the
// clock the restart budget reads. Install it after startPlayback, because
// waitFor needs real timers. The afterEach hook of the describe block
// restores real timers.
function useRecoveryClock(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
}

// The async form lets promise callbacks run between timers, which a fetch
// that resolves or rejects needs.
async function advanceRecovery(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// The descriptor the Nth fetch of the same episode returns. Every descriptor
// request mints its own session and token, so each one here has its own.
function restartDescriptor(
  n: number,
  viewOffsetMs: number | null = null,
): WatchDescriptor {
  return buildWatchDescriptor({
    ratingKey: "900001",
    sessionId: `session-example-${n}`,
    token: `example-token-${n}`,
    viewOffsetMs,
  });
}

// Resolves the Nth descriptor fetch of the episode with its own descriptor.
// Fetch N is the one that produced descriptor N, so the check that it is out
// makes a missing restart fail as an assertion.
async function resolveRestart(
  n: number,
  viewOffsetMs: number | null = null,
): Promise<WatchDescriptor> {
  expect(fetchCalls()).toHaveLength(n);
  const descriptor = restartDescriptor(n, viewOffsetMs);
  await resolveLatestEpisodeWatch(descriptor);
  return descriptor;
}

// The stream is working: the manifest parsed, a fragment buffered, and the
// viewer is at this position and playing.
function establishAt(
  hls: FakeHls,
  video: HTMLVideoElement,
  seconds: number,
): void {
  act(() => {
    emit(hls, FakeHls.Events.MANIFEST_PARSED, {});
    emit(hls, FakeHls.Events.FRAG_BUFFERED, {});
  });
  setMediaCurrentTime(video, seconds);
  act(() => {
    fireMediaEvent(video, "timeupdate");
    fireMediaEvent(video, "playing");
  });
}

// A fatal manifest timeout on the newest live instance, as an attempt whose
// session never answers produces.
function failLiveInstance(): void {
  const instance = liveInstances().at(-1);
  if (instance === undefined || instance.url === null) {
    throw new Error("no live Hls instance to fail");
  }
  const url = instance.url;
  act(() => {
    emit(instance, FakeHls.Events.ERROR, fatalManifestTimeout(url));
  });
}

// One restart attempt that fails on both connections: the local instance
// falls over to the remote URL of the same descriptor, and that fails too.
function failAttempt(): void {
  failLiveInstance();
  failLiveInstance();
}

function expectNoErrorState(): void {
  expect(screen.queryByText(/Loading stream/)).toBeNull();
  expect(document.querySelector(".watch-playback-diag")?.textContent ?? null).toBeNull();
}

function reconnectingBanner(): HTMLElement | null {
  return screen.queryByText("Reconnecting…");
}

// Phase 56.3 helpers. A segment failure after a long silence, and the clock
// move that creates the silence without running any timer.

function segmentUrl(descriptor: WatchDescriptor): string {
  return `${new URL(descriptor.hls.remote).origin}/video/:/transcode/universal/session/${descriptor.sessionId}/base/00042.ts?X-Plex-Token=${descriptor.transient}`;
}

// A non-fatal ERROR payload. details defaults to fragLoadError.
function nonFatalLoadError(descriptor: WatchDescriptor, details?: string) {
  return {
    type: FakeHls.ErrorTypes.NETWORK_ERROR,
    details: details ?? FakeHls.ErrorDetails.FRAG_LOAD_ERROR,
    fatal: false,
    response: { url: segmentUrl(descriptor), data: undefined, code: 0, text: "" },
    error: new Error("HTTP Error 0 "),
  };
}

function emitNonFatal(
  hls: FakeHls,
  descriptor: WatchDescriptor,
  details?: string,
): void {
  act(() => {
    emit(hls, FakeHls.Events.ERROR, nonFatalLoadError(descriptor, details));
  });
}

// Moves the faked wall clock forward. It does not run timers, so a recovery
// delay that was already scheduled stays where it is.
function advanceWallClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

// The stream is established and a fragment has loaded, which is the sign of
// life the silence is measured from. The recovery clock is installed here.
async function establishWithSignOfLife(): Promise<{
  descriptor: WatchDescriptor;
  video: HTMLVideoElement;
  hls: FakeHls;
}> {
  const started = await startPlayback();
  useRecoveryClock();
  establishAt(started.hls, started.video, 397.6);
  act(() => {
    emit(started.hls, FakeHls.Events.FRAG_LOADED, {});
  });
  return started;
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

  // Phase 56.2: a fatal error on a stream that was working restarts it.

  // Shared by the code 0 and code 404 tests. The viewer is off the LAN (spec
  // E4): the first descriptor has no local URL, so the stream plays on the
  // remote one. It is established at 397.6 s, a fatal fragLoadError arrives,
  // and the page restarts it with a fresh descriptor at the same place. The
  // fresh descriptor has a local URL, and that is the one the restart loads.
  async function expectRestartAfterFatal(code: number, text: string): Promise<void> {
    const first = buildWatchDescriptor({ local: null });
    const { descriptor, video, hls } = await startPlayback({ descriptor: first });
    establishAt(hls, video, 397.6);
    expect(fetchCalls()).toHaveLength(1);

    failFragments(hls, descriptor, code, text);

    expectNoErrorState();
    expect(fetchCalls()).toHaveLength(2);
    expect(fetchCalls()[1]?.[0]).toBe(descriptor.ratingKey);
    expect(fetchCalls()[1]?.[1]).toBeUndefined();
    // The old instance keeps what it has buffered while the fetch is out.
    expect(hls.destroyed).toBe(false);

    const next = await resolveRestart(2);

    expectNoErrorState();
    expect(hls.destroyed).toBe(true);
    const live = liveInstances();
    expect(live).toHaveLength(1);
    expect(live[0]?.url).toBe(next.hls.local);
    expect(live[0]?.media).toBe(video);
    expect(video.isConnected).toBe(true);

    const restarted = live[0];
    if (restarted === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    const playsBefore = mediaCalls(video).play;
    act(() => {
      emit(restarted, FakeHls.Events.MANIFEST_PARSED, {});
    });

    expect(video.currentTime).toBe(397.6);
    expect(mediaCalls(video).play).toBe(playsBefore + 1);
    expect(video.paused).toBe(false);
    expectNoErrorState();
  }

  it("restarts at the same place with a fresh descriptor after a fatal fragLoadError with code 0", async () => {
    await expectRestartAfterFatal(0, "");
  });

  it("restarts at the same place with a fresh descriptor after a fatal fragLoadError with code 404", async () => {
    await expectRestartAfterFatal(404, "Not Found");
  });

  it("fetches the next descriptor 3 s after an attempt fails and never loads an earlier descriptor's URL", async () => {
    const { descriptor, video, hls } = await startPlayback();
    useRecoveryClock();
    establishAt(hls, video, 397.6);

    failFragments(hls, descriptor, 0, "");
    const second = await resolveRestart(2);
    failAttempt();

    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).not.toBeNull();
    await advanceRecovery(2_999);
    expect(fetchCalls()).toHaveLength(2);
    await advanceRecovery(1);
    expect(fetchCalls()).toHaveLength(3);

    const third = await resolveRestart(3);

    expect(hlsInstances.map((instance) => instance.url)).toEqual([
      requireLocalUrl(descriptor),
      requireLocalUrl(second),
      second.hls.remote,
      requireLocalUrl(third),
    ]);
    expectNoErrorState();
  });

  it("passes the 720p tuning to a restart after a Quality switch", async () => {
    const { descriptor, video, hls } = await startPlayback();
    establishAt(hls, video, 1200);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Quality/ }));
    fireEvent.click(screen.getByRole("button", { name: "720p" }));
    const switched = await resolveRestart(2);
    const next = liveInstances()[0];
    if (next === undefined) {
      throw new Error("switched Hls instance is missing");
    }
    establishAt(next, video, 1210);
    const callsBefore = fetchCalls().length;

    failFragments(next, switched, 0, "");

    expectNoErrorState();
    expect(fetchCalls()).toHaveLength(callsBefore + 1);
    expect(fetchCalls().at(-1)).toEqual([
      descriptor.ratingKey,
      { maxVideoBitrate: 4000, videoResolution: "1280x720" },
    ]);
  });

  it("restarts paused when the error arrives while paused", async () => {
    const { descriptor, video, hls } = await startPlayback();
    establishAt(hls, video, 397.6);
    act(() => {
      video.pause();
    });

    failFragments(hls, descriptor, 0, "");
    expect(reconnectingBanner()).not.toBeNull();
    await resolveRestart(2);
    const restarted = liveInstances()[0];
    if (restarted === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    const calls = mediaCalls(video);
    act(() => {
      emit(restarted, FakeHls.Events.MANIFEST_PARSED, {});
    });

    expect(video.currentTime).toBe(397.6);
    expect(mediaCalls(video).play).toBe(calls.play);
    expect(mediaCalls(video).pause).toBe(calls.pause + 1);
    expect(video.paused).toBe(true);
    expectNoErrorState();

    // No playing event follows a paused restart, so the banner ends when the
    // restarted stream buffers a fragment.
    expect(reconnectingBanner()).not.toBeNull();
    act(() => {
      emit(restarted, FakeHls.Events.FRAG_BUFFERED, {});
    });
    expect(reconnectingBanner()).toBeNull();
  });

  it("counts a rejected descriptor fetch as a failed attempt and retries on the schedule", async () => {
    const { descriptor, video, hls } = await startPlayback();
    useRecoveryClock();
    establishAt(hls, video, 397.6);
    vi.mocked(fetchEpisodeWatch).mockImplementationOnce(() =>
      Promise.reject(new Error("descriptor unavailable")),
    );

    failFragments(hls, descriptor, 0, "");
    await advanceRecovery(0);

    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).not.toBeNull();
    expectNoErrorState();
    await advanceRecovery(2_999);
    expect(fetchCalls()).toHaveLength(2);
    await advanceRecovery(1);
    expect(fetchCalls()).toHaveLength(3);

    const next = await resolveRestart(3);

    expect(hls.destroyed).toBe(true);
    expect(liveInstances().map((instance) => instance.url)).toEqual([
      requireLocalUrl(next),
    ]);
    const restarted = liveInstances()[0];
    if (restarted === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    act(() => {
      emit(restarted, FakeHls.Events.MANIFEST_PARSED, {});
    });
    expect(video.currentTime).toBe(397.6);
  });

  it("gives up after four restarts in 5 minutes with a message that names the place", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { descriptor, video, hls } = await startPlayback();
      useRecoveryClock();
      establishAt(hls, video, 397.6);

      failFragments(hls, descriptor, 0, "");
      await resolveRestart(2);
      failAttempt();
      await advanceRecovery(3_000);
      expect(fetchCalls()).toHaveLength(3);
      await resolveRestart(3);
      failAttempt();
      await advanceRecovery(10_000);
      expect(fetchCalls()).toHaveLength(4);
      await resolveRestart(4);
      failAttempt();
      await advanceRecovery(30_000);
      expect(fetchCalls()).toHaveLength(5);
      expect(reconnectingBanner()).not.toBeNull();
      await resolveRestart(5);
      failAttempt();

      // The fifth restart in 5 minutes is refused.
      const diag = document.querySelector(".watch-playback-diag");
      if (!(diag instanceof HTMLElement) || diag.textContent === null) {
        throw new Error("playback error text is missing");
      }
      expect(diag.textContent).toContain("6:37");
      expect(diag.textContent).toContain("Reload");
      expect(diag.textContent).toContain("Playback stopped.");
      for (let n = 1; n <= 5; n += 1) {
        expect(diag.textContent).not.toContain(`example-token-${n}`);
      }
      expect(diag.textContent).not.toContain(descriptor.transient);
      // The paragraph is followed by a blank line and the report of the last
      // attach that failed: attempt 5, which failed on both connections. The
      // report of that attach alone is shown, not one per attempt.
      expect(diag.textContent).toMatch(/\n\nPlayback failed on all connections\./);
      expect(diag.textContent.split("Playback failed on all connections.")).toHaveLength(2);
      expect(diag.textContent).toContain("Descriptor had local URL: yes");
      expect(diag.textContent).toContain(
        "1. local — local.example.plex.direct/video/:/transcode/universal/start.m3u8",
      );
      expect(diag.textContent).toContain(
        "2. remote — remote.example.plex.direct/video/:/transcode/universal/start.m3u8",
      );
      expect(diag.textContent).toContain("manifestLoadTimeOut");
      expect(diag.textContent).not.toContain("The request for a new stream failed");
      expect(diag.textContent).not.toContain("X-Plex-Token");
      expect(liveInstances()).toEqual([]);
      expect(document.querySelector("video.watch-player")).toBeNull();
      expect(reconnectingBanner()).toBeNull();

      await advanceRecovery(300_000);
      expect(fetchCalls()).toHaveLength(5);

      const failure = error.mock.calls.find((call) => call[0] === "HLS playback failed");
      expect(failure).toBeDefined();
      const payload = failure?.[1] as { attempts?: unknown } | undefined;
      expect(Array.isArray(payload?.attempts)).toBe(true);

      const warnings = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("Playback recovery"));
      expect(warnings).toHaveLength(4);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("restarts after 0 ms when a restarted stream that buffered fails again", async () => {
    const { descriptor, video, hls } = await startPlayback();
    useRecoveryClock();
    establishAt(hls, video, 397.6);

    // The first attempt fails, so the delay index is 1.
    failFragments(hls, descriptor, 0, "");
    await resolveRestart(2);
    failAttempt();
    await advanceRecovery(3_000);
    expect(fetchCalls()).toHaveLength(3);

    // The second attempt buffers a fragment, which resets the delay index.
    const third = await resolveRestart(3);
    const restarted = liveInstances()[0];
    if (restarted === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    establishAt(restarted, video, 397.6);
    await advanceRecovery(20_000);
    setMediaCurrentTime(video, 417.6);
    act(() => {
      fireMediaEvent(video, "timeupdate");
    });

    failFragments(restarted, third, 0, "");

    // No timer advance: the fetch for the next restart is already out.
    expect(fetchCalls()).toHaveLength(4);
    expectNoErrorState();
    await resolveRestart(4);
    const again = liveInstances()[0];
    if (again === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    act(() => {
      emit(again, FakeHls.Events.MANIFEST_PARSED, {});
    });
    expect(video.currentTime).toBe(417.6);
  });

  it("changes nothing before the stream is established", async () => {
    const descriptor = buildWatchDescriptor({ local: null });
    const { hls } = await startPlayback({ descriptor });
    act(() => {
      emit(hls, FakeHls.Events.MANIFEST_PARSED, {});
    });

    failFragments(hls, descriptor, 0, "");

    expect(fetchCalls()).toHaveLength(1);
    expect(hlsInstances).toHaveLength(1);
    expect(reconnectingBanner()).toBeNull();
    expect(
      document
        .querySelector(".watch-playback-diag")
        ?.textContent?.startsWith("Playback failed on all connections."),
    ).toBe(true);
  });

  it("restarts a local stream that had buffered instead of falling to the remote URL of its session", async () => {
    const { descriptor, video, hls } = await startPlayback();
    establishAt(hls, video, 397.6);

    failFragments(hls, descriptor, 0, "");

    expect(hlsInstances).toHaveLength(1);
    expect(fetchCalls()).toHaveLength(2);
    const next = await resolveRestart(2);
    expect(hlsInstances.map((instance) => instance.url)).toEqual([
      requireLocalUrl(descriptor),
      requireLocalUrl(next),
    ]);
    expect(hlsInstances.map((instance) => instance.url)).not.toContain(
      descriptor.hls.remote,
    );
  });

  it("adds no attempt for errors from the old instance after a recovery began", async () => {
    const { descriptor, video, hls } = await startPlayback();
    useRecoveryClock();
    establishAt(hls, video, 397.6);

    failFragments(hls, descriptor, 0, "");
    expect(fetchCalls()).toHaveLength(2);
    failFragments(hls, descriptor, 0, "");
    failFragments(hls, descriptor, 404, "Not Found");
    await advanceRecovery(60_000);

    expect(fetchCalls()).toHaveLength(2);
    await resolveRestart(2);
    expect(liveInstances().map((instance) => instance.url)).toEqual([
      requireLocalUrl(restartDescriptor(2)),
    ]);
  });

  // The three cancellation tests start from the same place: attempt 1 has
  // failed, so the next one waits 3 s.
  async function startWaitingRecovery(): Promise<{
    descriptor: WatchDescriptor;
    video: HTMLVideoElement;
  }> {
    const { descriptor, video, hls } = await startPlayback();
    await screen.findByRole("link", { name: /Next episode/ });
    useRecoveryClock();
    establishAt(hls, video, 397.6);
    failFragments(hls, descriptor, 0, "");
    await resolveRestart(2);
    failAttempt();
    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).not.toBeNull();
    return { descriptor, video };
  }

  it("cancels a waiting attempt when the page navigates to another episode", async () => {
    vi.mocked(fetchNextEpisode).mockResolvedValue({
      ratingKey: "900002",
      seasonNumber: 1,
      episodeNumber: 2,
      title: "Second Example",
      thumb: null,
    });
    await startWaitingRecovery();

    fireEvent.click(screen.getByRole("link", { name: /Next episode/ }));
    await advanceRecovery(60_000);

    const forOldEpisode = fetchCalls().filter((call) => call[0] === "900001");
    expect(forOldEpisode).toHaveLength(2);
    expect(fetchCalls().filter((call) => call[0] === "900002")).toHaveLength(1);
    expect(reconnectingBanner()).toBeNull();
  });

  it("cancels a waiting attempt when Cast connects", async () => {
    vi.mocked(fetchNextEpisode).mockResolvedValue({
      ratingKey: "900002",
      seasonNumber: 1,
      episodeNumber: 2,
      title: "Second Example",
      thumb: null,
    });
    await startWaitingRecovery();

    setCastConnected(true);
    await advanceRecovery(60_000);

    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).toBeNull();
  });

  it("cancels a waiting attempt when a Quality switch starts and attaches only the switch's descriptor", async () => {
    vi.mocked(fetchNextEpisode).mockResolvedValue({
      ratingKey: "900002",
      seasonNumber: 1,
      episodeNumber: 2,
      title: "Second Example",
      thumb: null,
    });
    const { descriptor, video } = await startWaitingRecovery();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Quality/ }));
    fireEvent.click(screen.getByRole("button", { name: "720p" }));
    expect(fetchCalls()).toHaveLength(3);
    expect(fetchCalls().at(-1)).toEqual([
      descriptor.ratingKey,
      { maxVideoBitrate: 4000, videoResolution: "1280x720" },
    ]);
    const switched = await resolveRestart(3);
    await advanceRecovery(60_000);

    expect(fetchCalls()).toHaveLength(3);
    expect(liveInstances().map((instance) => instance.url)).toEqual([
      requireLocalUrl(switched),
    ]);
    expect(reconnectingBanner()).toBeNull();
    // The switch parked the recovery's position and intent, not the 0 the
    // torn-down element reads.
    const restarted = liveInstances()[0];
    if (restarted === undefined) {
      throw new Error("switched Hls instance is missing");
    }
    const playsBefore = mediaCalls(video).play;
    act(() => {
      emit(restarted, FakeHls.Events.MANIFEST_PARSED, {});
    });
    expect(video.currentTime).toBe(397.6);
    expect(mediaCalls(video).play).toBe(playsBefore + 1);
  });

  it("makes exactly one descriptor fetch for one fatal error under StrictMode", async () => {
    const { descriptor, video, hls } = await startPlayback({ strict: true });
    establishAt(hls, video, 397.6);
    const before = fetchCalls().length;

    failFragments(hls, descriptor, 0, "");

    expect(fetchCalls()).toHaveLength(before + 1);
  });

  it("shows Reconnecting from the fatal error until the restarted stream plays and never opens the Resume dialog", async () => {
    const { descriptor, video, hls } = await startPlayback();
    establishAt(hls, video, 397.6);
    expect(reconnectingBanner()).toBeNull();

    failFragments(hls, descriptor, 0, "");
    const banner = reconnectingBanner();
    expect(banner).not.toBeNull();
    const status = banner?.closest('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.classList.contains("watch-cast-status")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    // The new descriptor carries the position Plex saved, which would open
    // the Resume dialog on a first load.
    await resolveRestart(2, 300_000);
    expect(reconnectingBanner()).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    const restarted = liveInstances()[0];
    if (restarted === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    act(() => {
      emit(restarted, FakeHls.Events.MANIFEST_PARSED, {});
    });
    expect(reconnectingBanner()).not.toBeNull();
    act(() => {
      emit(restarted, FakeHls.Events.FRAG_BUFFERED, {});
    });
    expect(reconnectingBanner()).not.toBeNull();
    act(() => {
      fireMediaEvent(video, "playing");
    });

    expect(reconnectingBanner()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expectNoErrorState();
  });

  it("logs one warning per restart with the attempt, the delay and the error, and no token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { descriptor, video, hls } = await startPlayback();
      useRecoveryClock();
      establishAt(hls, video, 397.6);

      failFragments(hls, descriptor, 0, "");
      await resolveRestart(2);
      failAttempt();

      const messages = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("Playback recovery"));
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain("attempt 1");
      expect(messages[0]).toContain("0 ms");
      expect(messages[0]).toContain("networkError");
      expect(messages[0]).toContain("fragLoadError");
      expect(messages[0]).toContain(
        "local.example.plex.direct/video/:/transcode/universal/start.m3u8",
      );
      expect(messages[1]).toContain("attempt 2");
      expect(messages[1]).toContain("3000 ms");
      expect(messages[1]).toContain("networkError");
      expect(messages[1]).toContain("manifestLoadTimeOut");
      for (const message of messages) {
        expect(message).not.toContain("X-Plex-Token");
        expect(message).not.toContain("example-token");
        expect(message).not.toContain("session-example");
      }
    } finally {
      warn.mockRestore();
    }
  });

  // Phase 56.2 fix-up. The tests below pin the place a restart returns to, the
  // connection report in the give-up text, and guards that no earlier test
  // pinned.

  // A fatal fragment error on this descriptor's stream, as one emit.
  function fatalFragmentError(descriptor: WatchDescriptor) {
    const segmentUrl = `${new URL(descriptor.hls.remote).origin}/video/:/transcode/universal/session/${descriptor.sessionId}/base/00042.ts?X-Plex-Token=${descriptor.transient}`;
    return fragLoadError(segmentUrl, 0, "", true);
  }

  it("restarts at the place the element reached while the old stream played on its buffer", async () => {
    const { descriptor, video, hls } = await startPlayback();
    useRecoveryClock();
    establishAt(hls, video, 397.6);

    failFragments(hls, descriptor, 0, "");
    expect(fetchCalls()).toHaveLength(2);
    // The old instance stays attached and the element plays what it buffered.
    setMediaCurrentTime(video, 399.1);
    act(() => {
      fireMediaEvent(video, "timeupdate");
    });
    await resolveRestart(2);
    const restarted = liveInstances()[0];
    if (restarted === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    act(() => {
      emit(restarted, FakeHls.Events.MANIFEST_PARSED, {});
    });

    expect(video.currentTime).toBe(399.1);

    // The attempt fails. The place used at the attach is the one a later
    // attempt returns to, whatever the torn-down element reads.
    failAttempt();
    await advanceRecovery(3_000);
    setMediaCurrentTime(video, 0);
    await resolveRestart(3);
    const again = liveInstances()[0];
    if (again === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    act(() => {
      emit(again, FakeHls.Events.MANIFEST_PARSED, {});
    });
    expect(video.currentTime).toBe(399.1);
  });

  // Four descriptor fetches are rejected. The element is at 397.6 s at the
  // fatal error and at 420 s before the last fetch, so the give-up text has
  // to name 7:00. Returns the text of the error state.
  async function giveUpAfterRejectedFetches(): Promise<string> {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { descriptor, video, hls } = await startPlayback();
      useRecoveryClock();
      establishAt(hls, video, 397.6);
      for (let rejected = 0; rejected < 4; rejected += 1) {
        vi.mocked(fetchEpisodeWatch).mockImplementationOnce(() =>
          Promise.reject(new Error("descriptor unavailable")),
        );
      }

      failFragments(hls, descriptor, 0, "");
      await advanceRecovery(0);
      expect(fetchCalls()).toHaveLength(2);
      await advanceRecovery(3_000);
      expect(fetchCalls()).toHaveLength(3);
      await advanceRecovery(10_000);
      expect(fetchCalls()).toHaveLength(4);
      setMediaCurrentTime(video, 420);
      await advanceRecovery(30_000);
      expect(fetchCalls()).toHaveLength(5);

      const diag = document.querySelector(".watch-playback-diag");
      if (!(diag instanceof HTMLElement) || diag.textContent === null) {
        throw new Error("playback error text is missing");
      }
      expect(liveInstances()).toEqual([]);
      return diag.textContent;
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  }

  it("names the place the element reached when the give-up follows rejected fetches", async () => {
    const text = await giveUpAfterRejectedFetches();

    expect(text).toContain("Playback stopped.");
    expect(text).toContain("7:00");
    expect(text).not.toContain("6:37");
  });

  it("ends the give-up text with the failed request when the last attempt failed at the fetch", async () => {
    const text = await giveUpAfterRejectedFetches();

    // No attempt attached, so the report is the item's original stream: a
    // local stream that buffered and then failed on a fragment.
    expect(text).toMatch(/\n\nPlayback failed on all connections\./);
    expect(text).toContain("Descriptor had local URL: yes");
    expect(text).toContain(
      "1. local — local.example.plex.direct/video/:/transcode/universal/start.m3u8",
    );
    expect(text).toContain("details: fragLoadError");
    expect(text.endsWith("\nThe request for a new stream failed: descriptor unavailable.")).toBe(
      true,
    );
    expect(text).not.toContain("X-Plex-Token");
    expect(text).not.toContain("example-token");
  });

  it("ignores a fatal error and a buffered fragment from the old instance while the new descriptor commits", async () => {
    const { descriptor, video, hls } = await startPlayback();
    useRecoveryClock();
    establishAt(hls, video, 397.6);
    failFragments(hls, descriptor, 0, "");
    expect(fetchCalls()).toHaveLength(2);

    // Inside the act that resolves the fetch, after the page's callback ran
    // and before React commits its descriptor, the old instance is still
    // attached.
    await resolveLatestEpisodeWatchThen(restartDescriptor(2), () => {
      expect(hls.destroyed).toBe(false);
      emit(hls, FakeHls.Events.ERROR, fatalFragmentError(descriptor));
      emit(hls, FakeHls.Events.FRAG_BUFFERED, {});
    });

    expect(hls.destroyed).toBe(true);
    expect(liveInstances().map((instance) => instance.url)).toEqual([
      requireLocalUrl(restartDescriptor(2)),
    ]);
    await advanceRecovery(60_000);
    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).not.toBeNull();

    // The new attach fails on both connections. It is the first failed
    // attempt, so the next fetch waits 3 s.
    failAttempt();
    expect(fetchCalls()).toHaveLength(2);
    await advanceRecovery(2_999);
    expect(fetchCalls()).toHaveLength(2);
    await advanceRecovery(1);
    expect(fetchCalls()).toHaveLength(3);
  });

  it("leaves a fatal error to a Quality switch whose fetch is still out", async () => {
    const { descriptor, video, hls } = await startPlayback();
    useRecoveryClock();
    establishAt(hls, video, 397.6);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Quality/ }));
    fireEvent.click(screen.getByRole("button", { name: "720p" }));
    expect(fetchCalls()).toHaveLength(2);

    failFragments(hls, descriptor, 0, "");

    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).toBeNull();
    expectNoErrorState();

    const switched = await resolveRestart(2);
    await advanceRecovery(60_000);

    expect(hlsInstances.map((instance) => instance.url)).toEqual([
      requireLocalUrl(descriptor),
      requireLocalUrl(switched),
    ]);
    expect(liveInstances()).toHaveLength(1);
    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).toBeNull();
  });

  // Episode 2 of the tests below. The default is a local stream.
  async function openSecondEpisode(
    descriptorOptions?: WatchDescriptorOptions,
  ): Promise<{ descriptor: WatchDescriptor; video: HTMLVideoElement; hls: FakeHls }> {
    fireEvent.click(screen.getByRole("link", { name: /Next episode/ }));
    expect(fetchCalls().at(-1)?.[0]).toBe("900002");
    const descriptor = buildWatchDescriptor({
      ...descriptorOptions,
      ratingKey: "900002",
      sessionId: "session-example-ep2",
      token: "example-token-ep2",
    });
    await resolveLatestEpisodeWatch(descriptor);
    const hls = liveInstances().at(-1);
    if (hls === undefined) {
      throw new Error("episode 2 Hls instance is missing");
    }
    return { descriptor, video: watchVideo(), hls };
  }

  function mockSecondEpisode(): void {
    vi.mocked(fetchNextEpisode).mockResolvedValue({
      ratingKey: "900002",
      seasonNumber: 1,
      episodeNumber: 2,
      title: "Second Example",
      thumb: null,
    });
  }

  it("asks for no tuning on the next episode after a Quality switch on the first", async () => {
    mockSecondEpisode();
    const { video, hls } = await startPlayback();
    await screen.findByRole("link", { name: /Next episode/ });
    establishAt(hls, video, 1200);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Quality/ }));
    fireEvent.click(screen.getByRole("button", { name: "720p" }));
    await resolveRestart(2);

    const second = await openSecondEpisode();
    establishAt(second.hls, second.video, 120);
    const before = fetchCalls().length;
    failFragments(second.hls, second.descriptor, 0, "");

    expect(fetchCalls()).toHaveLength(before + 1);
    expect(fetchCalls().at(-1)?.[0]).toBe("900002");
    expect(fetchCalls().at(-1)?.[1]).toBeUndefined();
  });

  it("shows the error state for a stream of the next episode that never buffered, though the first had", async () => {
    mockSecondEpisode();
    const { video, hls } = await startPlayback();
    await screen.findByRole("link", { name: /Next episode/ });
    establishAt(hls, video, 1200);

    const second = await openSecondEpisode({ local: null });
    act(() => {
      emit(second.hls, FakeHls.Events.MANIFEST_PARSED, {});
    });
    const before = fetchCalls().length;
    failFragments(second.hls, second.descriptor, 0, "");

    expect(fetchCalls()).toHaveLength(before);
    expect(reconnectingBanner()).toBeNull();
    expect(
      document
        .querySelector(".watch-playback-diag")
        ?.textContent?.startsWith("Playback failed on all connections."),
    ).toBe(true);
  });

  it("starts the next episode with a fresh restart budget after four restarts on the first", async () => {
    mockSecondEpisode();
    const { descriptor, video, hls } = await startPlayback();
    await screen.findByRole("link", { name: /Next episode/ });
    useRecoveryClock();
    establishAt(hls, video, 397.6);

    failFragments(hls, descriptor, 0, "");
    await resolveRestart(2);
    failAttempt();
    await advanceRecovery(3_000);
    await resolveRestart(3);
    failAttempt();
    await advanceRecovery(10_000);
    await resolveRestart(4);
    failAttempt();
    await advanceRecovery(30_000);
    // The fourth restart in 5 minutes has its fetch out.
    expect(fetchCalls()).toHaveLength(5);

    const second = await openSecondEpisode();
    establishAt(second.hls, second.video, 120);
    const before = fetchCalls().length;
    failFragments(second.hls, second.descriptor, 0, "");

    expectNoErrorState();
    expect(fetchCalls()).toHaveLength(before + 1);
    expect(fetchCalls().at(-1)?.[0]).toBe("900002");
    expect(reconnectingBanner()).not.toBeNull();
  });

  it("attaches nothing from a restart fetch that resolves after the page moved to the next episode", async () => {
    mockSecondEpisode();
    const { descriptor, video, hls } = await startPlayback();
    await screen.findByRole("link", { name: /Next episode/ });
    establishAt(hls, video, 397.6);
    failFragments(hls, descriptor, 0, "");
    expect(fetchCalls()).toHaveLength(2);

    const second = await openSecondEpisode();
    await resolvePendingEpisodeWatchFor(restartDescriptor(2));

    expect(hlsInstances.map((instance) => instance.url)).toEqual([
      requireLocalUrl(descriptor),
      requireLocalUrl(second.descriptor),
    ]);
    expect(liveInstances()).toHaveLength(1);
    expect(liveInstances()[0]?.url).toBe(requireLocalUrl(second.descriptor));
    expect(reconnectingBanner()).toBeNull();
  });

  // Phase 56.2 fix-up 2. A Quality switch parks a seek and the HLS effect
  // pauses the element until the new manifest applies it. A recovery that
  // begins in that gap takes its place and play intent from the parked seek,
  // because the element reads paused although the viewer was playing.

  function chooseQuality720(): void {
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Quality/ }));
    fireEvent.click(screen.getByRole("button", { name: "720p" }));
  }

  // Established at 397.6 s, Quality 720p, and the switch's new session fails on
  // both connections before its manifest loads. Returns once the restart
  // attempt has attached and its manifest parsed, with the media calls made
  // by that parse.
  async function restartAfterFailedSwitch(
    pauseFirst: boolean,
  ): Promise<{ video: HTMLVideoElement; play: number; pause: number }> {
    const { descriptor, video, hls } = await startPlayback();
    establishAt(hls, video, 397.6);
    if (pauseFirst) {
      act(() => {
        video.pause();
      });
    }
    chooseQuality720();
    await resolveRestart(2);
    failAttempt();

    expect(fetchCalls()).toHaveLength(3);
    expect(fetchCalls().at(-1)).toEqual([
      descriptor.ratingKey,
      { maxVideoBitrate: 4000, videoResolution: "1280x720" },
    ]);
    await resolveRestart(3);
    const restarted = liveInstances()[0];
    if (restarted === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    const before = mediaCalls(video);
    act(() => {
      emit(restarted, FakeHls.Events.MANIFEST_PARSED, {});
    });
    expect(video.currentTime).toBe(397.6);
    const after = mediaCalls(video);
    return {
      video,
      play: after.play - before.play,
      pause: after.pause - before.pause,
    };
  }

  it("restarts playing when the switch's stream failed before it applied the parked seek", async () => {
    const calls = await restartAfterFailedSwitch(false);

    expect(calls.play).toBe(1);
    expect(calls.pause).toBe(0);
    expect(calls.video.paused).toBe(false);
  });

  it("restarts paused when the viewer was paused before the switch and its stream failed", async () => {
    const calls = await restartAfterFailedSwitch(true);

    expect(calls.play).toBe(0);
    expect(calls.pause).toBe(1);
    expect(calls.video.paused).toBe(true);
  });

  it("parks the element's place when a Quality switch cancels a recovery whose fetch was rejected", async () => {
    const { descriptor, video, hls } = await startPlayback();
    useRecoveryClock();
    establishAt(hls, video, 397.6);
    vi.mocked(fetchEpisodeWatch).mockImplementationOnce(() =>
      Promise.reject(new Error("descriptor unavailable")),
    );

    failFragments(hls, descriptor, 0, "");
    await advanceRecovery(0);
    expect(fetchCalls()).toHaveLength(2);
    // The old stream plays on its buffer during the 3 s wait.
    setMediaCurrentTime(video, 399.1);
    act(() => {
      fireMediaEvent(video, "timeupdate");
    });
    chooseQuality720();
    await resolveRestart(3);
    const switched = liveInstances()[0];
    if (switched === undefined) {
      throw new Error("switched Hls instance is missing");
    }
    const playsBefore = mediaCalls(video).play;
    act(() => {
      emit(switched, FakeHls.Events.MANIFEST_PARSED, {});
    });

    expect(video.currentTime).toBe(399.1);
    expect(mediaCalls(video).play).toBe(playsBefore + 1);
  });

  it("ignores a restart fetch for the first episode that is rejected after the page moved to the next episode", async () => {
    mockSecondEpisode();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { descriptor, video, hls } = await startPlayback();
      await screen.findByRole("link", { name: /Next episode/ });
      useRecoveryClock();
      establishAt(hls, video, 397.6);
      failFragments(hls, descriptor, 0, "");
      expect(fetchCalls()).toHaveLength(2);
      const recoveryWarnings = () =>
        warn.mock.calls.filter((call) => String(call[0]).includes("Playback recovery"))
          .length;
      expect(recoveryWarnings()).toBe(1);

      const second = await openSecondEpisode();
      await rejectPendingEpisodeWatchFor("900001", new Error("descriptor unavailable"));
      await advanceRecovery(60_000);

      expect(recoveryWarnings()).toBe(1);
      expect(fetchCalls().filter((call) => call[0] === "900001")).toHaveLength(2);

      // Episode 2 starts with an unspent budget, so its first restart is at once.
      establishAt(second.hls, second.video, 120);
      const before = fetchCalls().length;
      failFragments(second.hls, second.descriptor, 0, "");

      expect(fetchCalls()).toHaveLength(before + 1);
      expect(fetchCalls().at(-1)?.[0]).toBe("900002");
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves the request line out of the give-up text when later attempts attached and failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { descriptor, video, hls } = await startPlayback();
      useRecoveryClock();
      establishAt(hls, video, 397.6);
      vi.mocked(fetchEpisodeWatch).mockImplementationOnce(() =>
        Promise.reject(new Error("descriptor unavailable")),
      );

      // Restart 1 is rejected at the fetch. Restarts 2 to 4 attach and fail.
      failFragments(hls, descriptor, 0, "");
      await advanceRecovery(0);
      expect(fetchCalls()).toHaveLength(2);
      await advanceRecovery(3_000);
      await resolveRestart(3);
      failAttempt();
      await advanceRecovery(10_000);
      await resolveRestart(4);
      failAttempt();
      await advanceRecovery(30_000);
      await resolveRestart(5);
      failAttempt();

      const diag = document.querySelector(".watch-playback-diag");
      if (!(diag instanceof HTMLElement) || diag.textContent === null) {
        throw new Error("playback error text is missing");
      }
      expect(diag.textContent).toContain("Playback stopped.");
      expect(diag.textContent).toMatch(/\n\nPlayback failed on all connections\./);
      expect(diag.textContent.split("Playback failed on all connections.")).toHaveLength(2);
      expect(diag.textContent).toContain(
        "2. remote — remote.example.plex.direct/video/:/transcode/universal/start.m3u8",
      );
      expect(diag.textContent).not.toContain("The request for a new stream failed");
      expect(diag.textContent).not.toContain("descriptor unavailable");
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  // Phase 56.3: the first failed segment after a long silence restarts at once.

  it("restarts at the first non-fatal fragment error after 340 s without a sign of life", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { descriptor, hls } = await establishWithSignOfLife();
      advanceWallClock(340_000);

      emitNonFatal(hls, descriptor);

      expect(reconnectingBanner()).not.toBeNull();
      expect(fetchCalls()).toHaveLength(2);
      expectNoErrorState();

      // The retries hls.js would still make, and the fatal error they end in,
      // belong to the session the recovery already left.
      act(() => {
        for (let retry = 0; retry < 5; retry += 1) {
          emit(hls, FakeHls.Events.ERROR, nonFatalLoadError(descriptor));
        }
        emit(
          hls,
          FakeHls.Events.ERROR,
          fragLoadError(segmentUrl(descriptor), 0, "", true),
        );
      });
      await advanceRecovery(60_000);

      expect(fetchCalls()).toHaveLength(2);
      expect(reconnectingBanner()).not.toBeNull();
      expectNoErrorState();

      const messages = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("Playback recovery"));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("attempt 1");
      expect(messages[0]).toContain("0 ms");
      expect(messages[0]).toContain("stale session");
      expect(messages[0]).toContain("340 s");
      expect(messages[0]).not.toContain("X-Plex-Token");
      expect(messages[0]).not.toContain("example-token");
      expect(messages[0]).not.toContain(descriptor.transient);
    } finally {
      warn.mockRestore();
    }
  });

  it("waits for the fatal error when the last sign of life was 100 s ago", async () => {
    const { descriptor, hls } = await establishWithSignOfLife();
    advanceWallClock(100_000);

    emitNonFatal(hls, descriptor);

    expect(fetchCalls()).toHaveLength(1);
    expect(reconnectingBanner()).toBeNull();
    expectNoErrorState();

    act(() => {
      emit(
        hls,
        FakeHls.Events.ERROR,
        fragLoadError(segmentUrl(descriptor), 0, "", true),
      );
    });

    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).not.toBeNull();
    expectNoErrorState();
  });

  it("starts a recovery once the silence passes 120 s and not at 120 s", async () => {
    const { descriptor, hls } = await establishWithSignOfLife();
    advanceWallClock(120_000);

    emitNonFatal(hls, descriptor);

    expect(fetchCalls()).toHaveLength(1);
    expect(reconnectingBanner()).toBeNull();

    advanceWallClock(1);
    emitNonFatal(hls, descriptor);

    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).not.toBeNull();
    expectNoErrorState();
  });

  it("restarts on a non-fatal fragLoadTimeOut after a long silence", async () => {
    const { descriptor, hls } = await establishWithSignOfLife();
    advanceWallClock(340_000);

    emitNonFatal(hls, descriptor, FakeHls.ErrorDetails.FRAG_LOAD_TIMEOUT);

    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).not.toBeNull();
    expectNoErrorState();
  });

  it("does not restart on a non-fatal buffer stall, level load or manifest load error", async () => {
    const { descriptor, hls } = await establishWithSignOfLife();
    advanceWallClock(340_000);

    emitNonFatal(hls, descriptor, FakeHls.ErrorDetails.BUFFER_STALLED_ERROR);
    emitNonFatal(hls, descriptor, FakeHls.ErrorDetails.LEVEL_LOAD_ERROR);
    emitNonFatal(hls, descriptor, FakeHls.ErrorDetails.MANIFEST_LOAD_ERROR);

    expect(fetchCalls()).toHaveLength(1);
    expect(reconnectingBanner()).toBeNull();
    expectNoErrorState();
  });

  it("treats the restarted stream's parsed manifest as a new sign of life", async () => {
    const { descriptor, hls } = await establishWithSignOfLife();
    advanceWallClock(340_000);
    emitNonFatal(hls, descriptor);
    expect(fetchCalls()).toHaveLength(2);

    await resolveRestart(2);
    const restarted = liveInstances()[0];
    if (restarted === undefined) {
      throw new Error("restarted Hls instance is missing");
    }
    act(() => {
      emit(restarted, FakeHls.Events.MANIFEST_PARSED, {});
    });
    advanceWallClock(5_000);
    const next = restartDescriptor(2);
    emitNonFatal(restarted, next);

    expect(fetchCalls()).toHaveLength(2);
    expectNoErrorState();
  });

  it("starts nothing on a non-fatal error when the item has no sign of life yet", async () => {
    const descriptor = buildWatchDescriptor();
    const { hls } = await startPlayback({ descriptor });
    useRecoveryClock();
    advanceWallClock(340_000);

    emitNonFatal(hls, descriptor);

    expect(fetchCalls()).toHaveLength(1);
    expect(reconnectingBanner()).toBeNull();
    expectNoErrorState();
  });

  it("still restarts from wall time when performance.now() does not move", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1234);
    try {
      const { descriptor, hls } = await establishWithSignOfLife();
      advanceWallClock(340_000);
      expect(performance.now()).toBe(1234);

      emitNonFatal(hls, descriptor);

      expect(performance.now()).toBe(1234);
      expect(reconnectingBanner()).not.toBeNull();
      expect(fetchCalls()).toHaveLength(2);
      expectNoErrorState();
    } finally {
      clock.mockRestore();
    }
  });

  it("starts nothing for a stream that never buffered, and its fatal error then fails playback", async () => {
    const descriptor = buildWatchDescriptor({ local: null });
    const { hls } = await startPlayback({ descriptor });
    useRecoveryClock();
    act(() => {
      emit(hls, FakeHls.Events.MANIFEST_PARSED, {});
    });
    advanceWallClock(340_000);

    emitNonFatal(hls, descriptor);

    expect(fetchCalls()).toHaveLength(1);
    expect(reconnectingBanner()).toBeNull();
    expect(document.querySelector(".watch-playback-diag")).toBeNull();

    act(() => {
      emit(
        hls,
        FakeHls.Events.ERROR,
        fragLoadError(segmentUrl(descriptor), 0, "", true),
      );
    });

    expect(fetchCalls()).toHaveLength(1);
    expect(reconnectingBanner()).toBeNull();
    expect(
      document
        .querySelector(".watch-playback-diag")
        ?.textContent?.startsWith("Playback failed on all connections."),
    ).toBe(true);
  });

  // Pins the FRAG_LOADED stamp. The other silence tests load their fragment at
  // the same moment the manifest parses, so either stamp would satisfy them.
  // This one loads a fragment 200 s into playback and fails a segment 100 s
  // later. That is inside the 120 s margin. Without the stamp the sign of life
  // would stay at the stream's start, 300 s earlier, and the blip would restart
  // the stream.
  it("does not restart a blip 100 s after a fragment loaded during playback", async () => {
    const { descriptor, hls } = await establishWithSignOfLife();
    advanceWallClock(200_000);
    act(() => {
      emit(hls, FakeHls.Events.FRAG_LOADED, {});
    });
    advanceWallClock(100_000);

    emitNonFatal(hls, descriptor);

    expect(fetchCalls()).toHaveLength(1);
    expect(reconnectingBanner()).toBeNull();
  });

  // Pins the MANIFEST_PARSED stamp. A Quality switch after a long pause
  // attaches a new session, and its parsed manifest is a sign of life for that
  // session. Without the stamp the first segment error on it would count the
  // pause as silence and restart.
  it("does not restart the first segment error after a Quality switch that followed a long pause", async () => {
    const { video } = await establishWithSignOfLife();
    act(() => {
      video.pause();
    });
    advanceWallClock(300_000);
    chooseQuality720();
    await resolveRestart(2);
    const switched = liveInstances()[0];
    if (switched === undefined) {
      throw new Error("switched Hls instance is missing");
    }
    act(() => {
      emit(switched, FakeHls.Events.MANIFEST_PARSED, {});
    });

    emitNonFatal(switched, restartDescriptor(2));

    expect(fetchCalls()).toHaveLength(2);
    expect(reconnectingBanner()).toBeNull();
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
