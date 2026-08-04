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

    onReady({ videoRef, play, pause });
  }, [onReady]);

  return (
    <PlayerControls
      videoRef={videoRef}
      durationMs={120_000}
      audioTracks={audioTracks}
      subtitleTracks={subtitleTracks}
      autoPlay={autoPlay}
      onAutoPlayChange={onAutoPlayChange}
      onStreamSettingsChange={onStreamSettingsChange ?? (async () => {})}
      remote={remote}
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
