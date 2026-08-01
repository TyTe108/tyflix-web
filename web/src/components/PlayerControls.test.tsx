// Behavioral tests for PlayerControls mobile changes (36.2): tap-to-reveal
// instead of pause-on-first-tap, and the three-way fullscreen fallback.
//
// Layout (two-row bar, hidden volume, 44px hit targets, Up Next clearance) is
// CSS and is not asserted here — jsdom does not apply the stylesheet.
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
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setViewport } from "../test/setup";
import { PlayerControls } from "./PlayerControls";

type VideoHarness = {
  videoRef: RefObject<HTMLVideoElement | null>;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
};

function PlayerHarness({
  onReady,
  children,
}: {
  onReady: (harness: VideoHarness) => void;
  children?: ReactNode;
}) {
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
      audioTracks={[]}
      subtitleTracks={[]}
      onStreamSettingsChange={async () => {}}
    >
      <video ref={videoRef} data-testid="player-video" />
      {children}
    </PlayerControls>
  );
}

function mountPlayer(): Promise<VideoHarness> {
  return new Promise((resolve) => {
    render(<PlayerHarness onReady={resolve} />);
  });
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
