// Behavioral tests for PlayerControls mobile changes (36.2): tap-to-reveal
// instead of pause-on-first-tap, and the three-way fullscreen fallback; plus
// the two-level settings menu (39.1).
//
// Layout (two-row bar, hidden volume, 44px hit targets, Up Next clearance,
// single-column submenu, ellipsis truncation) is CSS and is not asserted
// here — jsdom does not apply the stylesheet.
//
// Viewport control is setViewport from src/test/setup.ts. Cast stays
// unavailable in jsdom, so the cast button is absent and does not interfere.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioStream, SubtitleStream } from "../api/watch";
import type { RemotePlaybackControl } from "../cast/useCastPlayer";
import { setViewport } from "../test/setup";
import { PlayerControls, type StreamSettings } from "./PlayerControls";

type VideoHarness = {
  videoRef: RefObject<HTMLVideoElement | null>;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  setCurrentTime: (seconds: number) => void;
  /** When true, currentTime writes store without dispatching timeupdate. */
  setDeferTimeUpdate: (defer: boolean) => void;
};

type PlayerHarnessProps = {
  onReady: (harness: VideoHarness) => void;
  children?: ReactNode;
  audioTracks?: AudioStream[];
  subtitleTracks?: SubtitleStream[];
  autoPlay?: boolean;
  onAutoPlayChange?: (value: boolean) => void;
  onStreamSettingsChange?: (settings: StreamSettings) => Promise<void>;
  remote?: RemotePlaybackControl;
  enterFullscreenOnMount?: boolean;
  durationMs?: number | null;
};

function PlayerHarness({
  onReady,
  children,
  audioTracks = [],
  subtitleTracks = [],
  autoPlay,
  onAutoPlayChange,
  onStreamSettingsChange,
  remote,
  enterFullscreenOnMount,
  durationMs = 120_000,
}: PlayerHarnessProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }

    let paused = true;
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused,
    });

    let currentTime = 0;
    let deferTimeUpdate = false;
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
        if (!deferTimeUpdate) {
          video.dispatchEvent(new Event("timeupdate"));
        }
      },
    });

    const play = vi.fn(async () => {
      paused = false;
      video.dispatchEvent(new Event("play"));
    });
    const pause = vi.fn(() => {
      paused = true;
      video.dispatchEvent(new Event("pause"));
    });
    video.play = play as HTMLVideoElement["play"];
    video.pause = pause as HTMLVideoElement["pause"];

    const setCurrentTime = (seconds: number) => {
      video.currentTime = seconds;
    };
    const setDeferTimeUpdate = (defer: boolean) => {
      deferTimeUpdate = defer;
    };

    onReady({ videoRef, play, pause, setCurrentTime, setDeferTimeUpdate });
  }, [onReady]);

  return (
    <PlayerControls
      videoRef={videoRef}
      durationMs={durationMs}
      audioTracks={audioTracks}
      subtitleTracks={subtitleTracks}
      autoPlay={autoPlay}
      onAutoPlayChange={onAutoPlayChange}
      onStreamSettingsChange={onStreamSettingsChange ?? (async () => {})}
      remote={remote}
      enterFullscreenOnMount={enterFullscreenOnMount}
    >
      <video ref={videoRef} data-testid="player-video" />
      {children}
    </PlayerControls>
  );
}

function mountPlayer(
  props: Omit<PlayerHarnessProps, "onReady"> = {},
): Promise<VideoHarness> {
  return new Promise((resolve) => {
    render(<PlayerHarness onReady={resolve} {...props} />);
  });
}

function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  screen.getByRole("heading", { name: "Settings" });
}

const SAMPLE_AUDIO: AudioStream[] = [
  {
    id: "a1",
    language: "English",
    codec: "ac3",
    channels: 6,
    title: null,
    default: true,
  },
  {
    id: "a2",
    language: "English",
    codec: "ac3",
    channels: 2,
    title: "Director's Commentary",
    default: false,
  },
  {
    id: "a3",
    language: "Spanish",
    codec: "aac",
    channels: 2,
    title: null,
    default: false,
  },
];

const SAMPLE_SUBTITLES: SubtitleStream[] = [
  {
    id: "s1",
    language: "English",
    codec: "srt",
    title: "English",
    forced: false,
    external: false,
    textBased: true,
  },
  {
    id: "s2",
    language: "English",
    codec: "srt",
    title: "English",
    forced: false,
    external: true,
    textBased: true,
  },
  {
    id: "s3",
    language: "Spanish",
    codec: "srt",
    title: "Latin American",
    forced: false,
    external: false,
    textBased: true,
  },
  {
    id: "s4",
    language: "French",
    codec: "srt",
    title: "Canada",
    forced: false,
    external: false,
    textBased: true,
  },
  {
    id: "s5",
    language: "German",
    codec: "srt",
    title: null,
    forced: false,
    external: false,
    textBased: true,
  },
];

function idleRemote(overrides: Partial<RemotePlaybackControl> = {}): RemotePlaybackControl {
  return {
    isActive: false,
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    deviceName: null,
    playOrPause: () => {},
    seek: () => {},
    setVolumeLevel: () => {},
    muteOrUnmute: () => {},
    ...overrides,
  };
}

async function hideControlsWhilePlaying(harness: VideoHarness) {
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  await waitFor(() => {
    expect(harness.play).toHaveBeenCalled();
  });
  await vi.advanceTimersByTimeAsync(3000);
  await waitFor(() => {
    expect(document.querySelector(".watch-controls--hidden")).not.toBeNull();
  });
  harness.play.mockClear();
  harness.pause.mockClear();
}

function mediaSurface(): HTMLElement {
  const el = document.querySelector(".watch-player-media");
  if (!(el instanceof HTMLElement)) {
    throw new Error("expected .watch-player-media");
  }
  return el;
}

function shellElement(): HTMLDivElement {
  const el = document.querySelector(".watch-player-shell");
  if (!(el instanceof HTMLDivElement)) {
    throw new Error("expected .watch-player-shell");
  }
  return el;
}

describe("PlayerControls media tap", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("mobile + controls hidden: media click reveals and does not toggle playback", async () => {
    setViewport("mobile");
    const harness = await mountPlayer();
    await hideControlsWhilePlaying(harness);

    fireEvent.click(mediaSurface());

    expect(harness.play).not.toHaveBeenCalled();
    expect(harness.pause).not.toHaveBeenCalled();
    expect(document.querySelector(".watch-controls--hidden")).toBeNull();
  });

  it("mobile + controls visible: media click toggles playback", async () => {
    setViewport("mobile");
    const harness = await mountPlayer();
    await hideControlsWhilePlaying(harness);

    fireEvent.click(mediaSurface());
    harness.play.mockClear();
    harness.pause.mockClear();

    fireEvent.click(mediaSurface());
    expect(harness.pause).toHaveBeenCalled();
  });

  it("mobile + settings open: media click closes settings and does nothing else", async () => {
    setViewport("mobile");
    const harness = await mountPlayer();
    await hideControlsWhilePlaying(harness);

    fireEvent.click(mediaSurface());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    screen.getByRole("heading", { name: "Settings" });
    harness.play.mockClear();
    harness.pause.mockClear();

    fireEvent.click(mediaSurface());

    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    expect(harness.play).not.toHaveBeenCalled();
    expect(harness.pause).not.toHaveBeenCalled();
  });

  it("desktop + controls hidden: media click toggles playback (no reveal branch)", async () => {
    setViewport("desktop");
    const harness = await mountPlayer();
    await hideControlsWhilePlaying(harness);

    fireEvent.click(mediaSurface());

    expect(harness.pause).toHaveBeenCalled();
  });
});

describe("PlayerControls fullscreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses shell.requestFullscreen when it exists", async () => {
    setViewport("desktop");
    const harness = await mountPlayer();
    void harness;

    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const shell = shellElement();
    shell.requestFullscreen = requestFullscreen;

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));

    expect(requestFullscreen).toHaveBeenCalled();
  });

  it("falls back to video.webkitEnterFullscreen when shell has no requestFullscreen", async () => {
    setViewport("mobile");
    const harness = await mountPlayer();

    const shell = shellElement();
    // iPhone Safari: Element.requestFullscreen is missing on arbitrary divs.
    Object.defineProperty(shell, "requestFullscreen", {
      configurable: true,
      value: undefined,
    });

    const webkitEnterFullscreen = vi.fn();
    const video = harness.videoRef.current;
    if (video === null) {
      throw new Error("expected video element");
    }
    Object.defineProperty(video, "webkitEnterFullscreen", {
      configurable: true,
      value: webkitEnterFullscreen,
    });

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));

    expect(webkitEnterFullscreen).toHaveBeenCalled();
  });

  it("falls back to webkitEnterFullscreen when requestFullscreen exists but rejects", async () => {
    setViewport("mobile");
    const harness = await mountPlayer();

    const requestFullscreen = vi
      .fn()
      .mockRejectedValue(new Error("Fullscreen denied"));
    const shell = shellElement();
    shell.requestFullscreen = requestFullscreen;

    const webkitEnterFullscreen = vi.fn();
    const video = harness.videoRef.current;
    if (video === null) {
      throw new Error("expected video element");
    }
    Object.defineProperty(video, "webkitEnterFullscreen", {
      configurable: true,
      value: webkitEnterFullscreen,
    });

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));

    await waitFor(() => {
      expect(webkitEnterFullscreen).toHaveBeenCalled();
    });
    expect(screen.queryByText(/fullscreen/i)).toBeNull();
  });

  it("surfaces a user-visible error when neither fullscreen API exists", async () => {
    setViewport("mobile");
    const harness = await mountPlayer();

    const shell = shellElement();
    Object.defineProperty(shell, "requestFullscreen", {
      configurable: true,
      value: undefined,
    });

    const video = harness.videoRef.current;
    if (video === null) {
      throw new Error("expected video element");
    }
    Object.defineProperty(video, "webkitEnterFullscreen", {
      configurable: true,
      value: undefined,
    });

    fireEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));

    screen.getByText(/fullscreen/i);
  });
});

describe("PlayerControls enterFullscreenOnMount", () => {
  let requestFullscreen: ReturnType<typeof vi.fn>;

  function stubUserActivation(isActive: boolean) {
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive, hasBeenActive: isActive },
    });
  }

  beforeEach(() => {
    setViewport("desktop");
    requestFullscreen = vi.fn().mockResolvedValue(undefined);
    // jsdom has no Element.requestFullscreen; the auto path runs on mount, so
    // the prototype has to be stubbed before render (unlike the button tests,
    // which assign on the shell instance after mount and before the click).
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      writable: true,
      value: requestFullscreen,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    Reflect.deleteProperty(navigator, "userActivation");
  });

  it("calls shell.requestFullscreen exactly once when activation is live", async () => {
    stubUserActivation(true);
    await mountPlayer({ enterFullscreenOnMount: true });

    const shell = shellElement();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen.mock.instances[0]).toBe(shell);
  });

  it("does not call requestFullscreen or render an error when activation is inactive", async () => {
    stubUserActivation(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await mountPlayer({ enterFullscreenOnMount: true });

    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(screen.queryByText(/fullscreen/i)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("does not call requestFullscreen or render an error when userActivation is absent", async () => {
    Reflect.deleteProperty(navigator, "userActivation");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await mountPlayer({ enterFullscreenOnMount: true });

    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(screen.queryByText(/fullscreen/i)).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatch(/absent|unsupported/);
  });

  it("does not call requestFullscreen on mount when enterFullscreenOnMount is absent", async () => {
    stubUserActivation(true);
    await mountPlayer();

    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("does not call requestFullscreen on mount when enterFullscreenOnMount is false", async () => {
    stubUserActivation(true);
    await mountPlayer({ enterFullscreenOnMount: false });

    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("does not fire a second request when a Cast session starts and ends", async () => {
    stubUserActivation(true);
    const onReady = vi.fn();
    const { rerender } = render(
      <PlayerHarness onReady={onReady} enterFullscreenOnMount />,
    );
    await waitFor(() => {
      expect(onReady).toHaveBeenCalled();
    });
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    // remoteActive IS an effect dependency, so connecting and dropping Cast
    // genuinely re-runs the effect. A quality/audio prop change never touches
    // its deps, which is why that rerender cannot exercise the once-per-mount
    // ref at all.
    rerender(
      <PlayerHarness
        onReady={onReady}
        enterFullscreenOnMount
        remote={idleRemote({ isActive: true })}
      />,
    );
    rerender(<PlayerHarness onReady={onReady} enterFullscreenOnMount />);

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("does not render an error banner when the automatic request is refused", async () => {
    stubUserActivation(true);
    requestFullscreen.mockRejectedValue(new Error("Fullscreen denied"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await mountPlayer({ enterFullscreenOnMount: true });

    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(screen.queryByText(/fullscreen/i)).toBeNull();
  });

  it("does not request fullscreen while a Cast session is active", async () => {
    stubUserActivation(true);
    await mountPlayer({
      enterFullscreenOnMount: true,
      remote: idleRemote({ isActive: true }),
    });

    expect(requestFullscreen).not.toHaveBeenCalled();
  });
});

describe("PlayerControls settings menu", () => {
  afterEach(() => {
    cleanup();
  });

  it("root shows one row per available group and no option buttons", async () => {
    setViewport("desktop");
    await mountPlayer({
      audioTracks: SAMPLE_AUDIO,
      subtitleTracks: SAMPLE_SUBTITLES,
      autoPlay: true,
      onAutoPlayChange: () => {},
    });
    openSettings();

    expect(screen.getByRole("button", { name: /Speed/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Quality/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Audio/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Subtitles/ })).toBeTruthy();
    expect(screen.getByText("Auto Play")).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Normal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Original" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Off" })).toBeNull();
  });

  it("Speed root row shows the current value as Normal at 1×", async () => {
    setViewport("desktop");
    await mountPlayer();
    openSettings();

    const speedRow = screen.getByRole("button", { name: /Speed/ });
    expect(speedRow.textContent).toMatch(/Speed/);
    expect(speedRow.textContent).toMatch(/Normal/);
  });

  it("long root values expose the full text on title and stay one accessible name", async () => {
    setViewport("desktop");
    await mountPlayer({ audioTracks: SAMPLE_AUDIO });
    openSettings();

    const audioRow = screen.getByRole("button", { name: /Audio/ });
    // Default track is English (ac3 6ch); title carries the full string.
    const valueEl = audioRow.querySelector("[title]");
    expect(valueEl).not.toBeNull();
    expect(valueEl?.getAttribute("title")).toMatch(/English/);
  });

  it("disambiguates colliding subtitle labels on the root row", async () => {
    setViewport("desktop");
    await mountPlayer({ subtitleTracks: SAMPLE_SUBTITLES });
    openSettings();

    // Pick the first English track via submenu so the root value is that track.
    fireEvent.click(screen.getByRole("button", { name: /Subtitles/ }));
    const englishButtons = screen.getAllByRole("button", { name: "English" });
    expect(englishButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(englishButtons[0]);
    await waitFor(() => {
      expect(englishButtons[0].getAttribute("aria-pressed")).toBe("true");
    });
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));

    const subtitlesRow = screen.getByRole("button", { name: /Subtitles/ });
    const valueText =
      subtitlesRow.querySelector("[title]")?.getAttribute("title") ?? "";
    // Must not be the bare colliding label alone.
    expect(valueText).not.toBe("English");
    expect(valueText).toMatch(/English/);
  });

  it("root subtitle value includes language when the raw label omits it", async () => {
    setViewport("desktop");
    await mountPlayer({ subtitleTracks: SAMPLE_SUBTITLES });
    openSettings();

    fireEvent.click(screen.getByRole("button", { name: /Subtitles/ }));
    fireEvent.click(screen.getByRole("button", { name: "Canada" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Canada" }).getAttribute("aria-pressed"),
      ).toBe("true");
    });
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));

    const subtitlesRow = screen.getByRole("button", { name: /Subtitles/ });
    const valueText =
      subtitlesRow.querySelector("[title]")?.getAttribute("title") ?? "";
    expect(valueText).toMatch(/Canada/);
    expect(valueText).toMatch(/French/);
  });

  it("opens a submenu for one group, with Back and the group heading", async () => {
    setViewport("desktop");
    await mountPlayer();
    openSettings();

    fireEvent.click(screen.getByRole("button", { name: /Speed/ }));

    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    screen.getByRole("heading", { name: "Speed" });
    screen.getByRole("button", { name: /Back/ });
    screen.getByRole("button", { name: "Normal" });
    expect(screen.queryByRole("button", { name: /Quality/ })).toBeNull();
  });

  it("picking Speed applies immediately and stays in the Speed submenu", async () => {
    setViewport("desktop");
    const harness = await mountPlayer();
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: /Speed/ }));

    fireEvent.click(screen.getByRole("button", { name: "1.5×" }));

    screen.getByRole("heading", { name: "Speed" });
    expect(
      screen.getByRole("button", { name: "1.5×" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(harness.videoRef.current?.playbackRate).toBe(1.5);
  });

  it("picking Quality stays in the submenu and waits for the stream change", async () => {
    setViewport("desktop");
    let resolveChange: (() => void) | undefined;
    const onStreamSettingsChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChange = resolve;
        }),
    );
    await mountPlayer({ onStreamSettingsChange });
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: /Quality/ }));

    fireEvent.click(screen.getByRole("button", { name: "720p" }));

    screen.getByRole("heading", { name: "Quality" });
    expect(
      screen.getByRole("button", { name: "Original" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "720p" }).getAttribute("aria-pressed"),
    ).toBe("false");

    resolveChange?.();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "720p" }).getAttribute("aria-pressed"),
      ).toBe("true");
    });
    screen.getByRole("heading", { name: "Quality" });
  });

  it("Auto Play toggle stays on the root menu", async () => {
    setViewport("desktop");
    const onAutoPlayChange = vi.fn();
    await mountPlayer({
      autoPlay: false,
      onAutoPlayChange,
    });
    openSettings();

    fireEvent.click(screen.getByRole("checkbox", { name: /Auto Play/i }));

    expect(onAutoPlayChange).toHaveBeenCalledWith(true);
    screen.getByRole("heading", { name: "Settings" });
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
  });

  it("omits Audio with no tracks and omits Speed while casting", async () => {
    setViewport("desktop");
    await mountPlayer({
      audioTracks: [],
      subtitleTracks: SAMPLE_SUBTITLES,
      remote: idleRemote({ isActive: true }),
    });
    openSettings();

    expect(screen.queryByRole("button", { name: /Speed/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Audio/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Quality/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Subtitles/ })).toBeTruthy();
  });

  it("closing via picture, gear, or Escape resets to root on next open", async () => {
    setViewport("desktop");
    await mountPlayer();
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: /Speed/ }));
    screen.getByRole("heading", { name: "Speed" });

    fireEvent.click(mediaSurface());
    expect(screen.queryByRole("heading", { name: "Speed" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();

    openSettings();
    screen.getByRole("heading", { name: "Settings" });
    expect(screen.queryByRole("heading", { name: "Speed" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Quality/ }));
    screen.getByRole("heading", { name: "Quality" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();

    openSettings();
    screen.getByRole("heading", { name: "Settings" });

    fireEvent.click(screen.getByRole("button", { name: /Speed/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Speed" })).toBeNull();

    openSettings();
    screen.getByRole("heading", { name: "Settings" });
    expect(screen.queryByRole("button", { name: /Speed/ })).toBeTruthy();
  });

  it("falls back to root when casting starts while the Speed submenu is open", async () => {
    setViewport("desktop");

    function CastToggleHarness() {
      const [active, setActive] = useState(false);
      const videoRef = useRef<HTMLVideoElement | null>(null);
      return (
        <>
          <button type="button" onClick={() => setActive(true)}>
            Start cast
          </button>
          <PlayerControls
            videoRef={videoRef}
            durationMs={120_000}
            audioTracks={[]}
            subtitleTracks={[]}
            onStreamSettingsChange={async () => {}}
            remote={idleRemote({ isActive: active })}
          >
            <video ref={videoRef} />
          </PlayerControls>
        </>
      );
    }

    render(<CastToggleHarness />);
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: /Speed/ }));
    screen.getByRole("heading", { name: "Speed" });

    fireEvent.click(screen.getByRole("button", { name: "Start cast" }));

    await waitFor(() => {
      screen.getByRole("heading", { name: "Settings" });
    });
    expect(screen.queryByRole("heading", { name: "Speed" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Speed/ })).toBeNull();
  });
});

// Criterion 9 (hide skip buttons below 48rem) is CSS-only. jsdom never loads
// styles.css, so visibility is left to the smoke test — asserting it here
// would pass for the wrong reason.
describe("PlayerControls skip", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setViewport("desktop");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function seedPosition(
    harness: VideoHarness,
    seconds: number,
  ): Promise<void> {
    harness.setCurrentTime(seconds);
    await waitFor(() => {
      expect(screen.getByRole("slider", { name: "Seek" })).toHaveProperty(
        "value",
        String(seconds),
      );
    });
  }

  it("renders skip back, play/pause, skip forward, then the clock in that order", async () => {
    await mountPlayer();

    const skipBack = screen.getByRole("button", {
      name: "Skip back 5 seconds",
    });
    const play = screen.getByRole("button", { name: "Play" });
    const skipForward = screen.getByRole("button", {
      name: "Skip forward 5 seconds",
    });
    const time = document.querySelector(".watch-time");
    if (!(time instanceof HTMLElement)) {
      throw new Error("expected .watch-time");
    }

    const bar = document.querySelector(".watch-controls-bar");
    if (!(bar instanceof HTMLElement)) {
      throw new Error("expected .watch-controls-bar");
    }
    const ordered = [...bar.children];
    expect(ordered.indexOf(skipBack)).toBeLessThan(ordered.indexOf(play));
    expect(ordered.indexOf(play)).toBeLessThan(ordered.indexOf(skipForward));
    expect(ordered.indexOf(skipForward)).toBeLessThan(ordered.indexOf(time));
  });

  it("skips back and forward by 5 seconds from mid-playback", async () => {
    const harness = await mountPlayer();
    await seedPosition(harness, 30);

    fireEvent.click(
      screen.getByRole("button", { name: "Skip back 5 seconds" }),
    );
    expect(harness.videoRef.current?.currentTime).toBe(25);

    await seedPosition(harness, 30);
    fireEvent.click(
      screen.getByRole("button", { name: "Skip forward 5 seconds" }),
    );
    expect(harness.videoRef.current?.currentTime).toBe(35);
  });

  it("clamps skip back to 0 near the start", async () => {
    const harness = await mountPlayer();
    await seedPosition(harness, 3);

    fireEvent.click(
      screen.getByRole("button", { name: "Skip back 5 seconds" }),
    );
    expect(harness.videoRef.current?.currentTime).toBe(0);
  });

  it("clamps skip forward to the duration near the end", async () => {
    const harness = await mountPlayer();
    await seedPosition(harness, 118);

    fireEvent.click(
      screen.getByRole("button", { name: "Skip forward 5 seconds" }),
    );
    expect(harness.videoRef.current?.currentTime).toBe(120);
  });

  it("while casting, seeks the receiver and never writes video.currentTime", async () => {
    const seek = vi.fn();
    const harness = await mountPlayer({
      remote: idleRemote({
        isActive: true,
        currentTime: 30,
        duration: 120,
        seek,
      }),
    });
    const video = harness.videoRef.current;
    if (video === null) {
      throw new Error("expected video element");
    }
    harness.setCurrentTime(99);

    fireEvent.click(
      screen.getByRole("button", { name: "Skip back 5 seconds" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Skip forward 5 seconds" }),
    );

    expect(seek).toHaveBeenCalledWith(25);
    expect(seek).toHaveBeenCalledWith(35);
    expect(video.currentTime).toBe(99);
  });

  it("while casting, clamps skip forward against the receiver duration", async () => {
    const seek = vi.fn();
    await mountPlayer({
      remote: idleRemote({
        isActive: true,
        currentTime: 58,
        duration: 60,
        seek,
      }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Skip forward 5 seconds" }),
    );
    expect(seek).toHaveBeenCalledWith(60);
  });

  it("disables both skip buttons when there is no duration yet", async () => {
    await mountPlayer({ durationMs: null });

    expect(
      screen.getByRole("button", { name: "Skip back 5 seconds" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Skip forward 5 seconds" }),
    ).toHaveProperty("disabled", true);
  });

  it("skips while paused and while playing", async () => {
    const harness = await mountPlayer();
    await seedPosition(harness, 40);

    fireEvent.click(
      screen.getByRole("button", { name: "Skip forward 5 seconds" }),
    );
    expect(harness.videoRef.current?.currentTime).toBe(45);

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => {
      expect(harness.play).toHaveBeenCalled();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Skip back 5 seconds" }),
    );
    expect(harness.videoRef.current?.currentTime).toBe(40);
  });

  it("reveals the control bar and re-arms the idle timer", async () => {
    const harness = await mountPlayer();
    await seedPosition(harness, 30);
    await hideControlsWhilePlaying(harness);

    fireEvent.click(
      screen.getByRole("button", { name: "Skip forward 5 seconds" }),
    );

    expect(document.querySelector(".watch-controls--hidden")).toBeNull();
    expect(harness.videoRef.current?.currentTime).toBe(35);

    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => {
      expect(document.querySelector(".watch-controls--hidden")).not.toBeNull();
    });
  });

  it("accumulates two rapid skips before timeupdate settles", async () => {
    const harness = await mountPlayer();
    await seedPosition(harness, 30);
    harness.setDeferTimeUpdate(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Skip forward 5 seconds" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Skip forward 5 seconds" }),
    );
    expect(harness.videoRef.current?.currentTime).toBe(40);

    harness.setDeferTimeUpdate(false);
    await seedPosition(harness, 30);
    harness.setDeferTimeUpdate(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Skip back 5 seconds" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Skip back 5 seconds" }),
    );
    expect(harness.videoRef.current?.currentTime).toBe(20);
  });
});
