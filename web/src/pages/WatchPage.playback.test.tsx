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
});
