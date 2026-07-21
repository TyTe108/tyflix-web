import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { AudioStream, SubtitleStream } from "../api/watch";

export type QualityId = "original" | "1080p" | "720p" | "480p";

export type StreamSettings = {
  quality: QualityId;
  audioStreamId: string | null;
  subtitleStreamId: string | null;
};

type PlayerControlsProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  durationMs: number | null;
  audioTracks: AudioStream[];
  subtitleTracks: SubtitleStream[];
  onStreamSettingsChange: (settings: StreamSettings) => Promise<void>;
  autoPlay?: boolean;
  onAutoPlayChange?: (value: boolean) => void;
  overlay?: ReactNode;
  children: ReactNode;
};

const HIDE_DELAY_MS = 3000;

const SPEED_OPTIONS = [
  { value: 0.5, label: "0.5×" },
  { value: 0.75, label: "0.75×" },
  { value: 1, label: "Normal" },
  { value: 1.25, label: "1.25×" },
  { value: 1.5, label: "1.5×" },
  { value: 1.75, label: "1.75×" },
  { value: 2, label: "2×" },
] as const;

const QUALITY_OPTIONS: ReadonlyArray<{ value: QualityId; label: string }> = [
  { value: "original", label: "Original" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
];

type SettingsOption<T extends string | number> = {
  value: T;
  label: string;
};

function SettingsOptionGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<SettingsOption<T>>;
  value: T;
  onChange: (value: T) => void;
}) {
  const headingId = `watch-settings-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="watch-settings-group" role="group" aria-labelledby={headingId}>
      <h3 id={headingId} className="watch-settings-group-label">
        {label}
      </h3>
      <div className="watch-settings-options">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={String(option.value)}
              type="button"
              className={
                selected
                  ? "watch-settings-option watch-settings-option--active"
                  : "watch-settings-option"
              }
              aria-pressed={selected}
              onClick={() => {
                onChange(option.value);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PlayerControls({
  videoRef,
  durationMs,
  audioTracks,
  subtitleTracks,
  onStreamSettingsChange,
  autoPlay,
  onAutoPlayChange,
  overlay,
  children,
}: PlayerControlsProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const gearRef = useRef<HTMLButtonElement | null>(null);
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const scrubbingRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsOpenRef = useRef(false);
  const playbackRateRef = useRef(1);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedQuality, setSelectedQuality] = useState<QualityId>("original");
  // null = use Plex default (highlight the default/first track in the UI).
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  // null = Off. We do not reflect a pre-existing server-side selection on load.
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(
    null,
  );

  settingsOpenRef.current = settingsOpen;
  playbackRateRef.current = playbackRate;

  const fallbackDuration =
    typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs > 0
      ? durationMs / 1000
      : 0;
  const fallbackDurationRef = useRef(fallbackDuration);
  fallbackDurationRef.current = fallbackDuration;

  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const scheduleHide = () => {
    clearHideTimer();
    const video = videoRef.current;
    if (video === null || video.paused || settingsOpenRef.current) {
      setControlsVisible(true);
      return;
    }
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, HIDE_DELAY_MS);
  };

  const revealControls = () => {
    setControlsVisible(true);
    scheduleHide();
  };

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }

    const resolveDuration = (): number => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        return video.duration;
      }
      return fallbackDurationRef.current;
    };

    const onPlayback = () => {
      setPlaying(!video.paused);
      if (video.paused || settingsOpenRef.current) {
        setControlsVisible(true);
        clearHideTimer();
      } else {
        scheduleHide();
      }
    };
    const onTime = () => {
      if (!scrubbingRef.current) {
        setCurrentTime(video.currentTime);
      }
      setDuration(resolveDuration());
    };
    const onVolume = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onEnded = () => {
      setPlaying(false);
      setControlsVisible(true);
      clearHideTimer();
    };
    const onRateChange = () => {
      setPlaybackRate(video.playbackRate);
    };
    // Re-apply the chosen rate after a source reload (e.g. future quality
    // restart) so the browser's default 1× does not silently win.
    const onLoadedMetadata = () => {
      video.playbackRate = playbackRateRef.current;
      onTime();
    };

    onPlayback();
    onTime();
    onVolume();
    onRateChange();

    video.addEventListener("play", onPlayback);
    video.addEventListener("pause", onPlayback);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("durationchange", onTime);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("volumechange", onVolume);
    video.addEventListener("ratechange", onRateChange);
    video.addEventListener("ended", onEnded);

    return () => {
      video.removeEventListener("play", onPlayback);
      video.removeEventListener("pause", onPlayback);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("durationchange", onTime);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("volumechange", onVolume);
      video.removeEventListener("ratechange", onRateChange);
      video.removeEventListener("ended", onEnded);
    };
  }, [videoRef]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const shell = shellRef.current;
      setFullscreen(
        shell !== null && document.fullscreenElement === shell,
      );
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) {
      scheduleHide();
      return;
    }
    setControlsVisible(true);
    clearHideTimer();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) {
        return;
      }
      if (settingsRef.current?.contains(target)) {
        return;
      }
      if (gearRef.current?.contains(target)) {
        return;
      }
      // Media clicks are handled by onMediaClick so dismiss doesn't race
      // with play/pause toggle on the same gesture.
      if (mediaRef.current?.contains(target)) {
        return;
      }
      setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [settingsOpen]);

  useEffect(() => {
    return () => {
      clearHideTimer();
    };
  }, []);

  const withVideo = (fn: (video: HTMLVideoElement) => void) => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    fn(video);
  };

  const togglePlay = () => {
    withVideo((video) => {
      if (video.paused) {
        void video.play().catch((err: unknown) => {
          console.error("Play failed", err);
        });
      } else {
        video.pause();
      }
    });
  };

  const onMediaClick = () => {
    if (settingsOpenRef.current) {
      setSettingsOpen(false);
      return;
    }
    togglePlay();
  };

  const toggleMute = () => {
    withVideo((video) => {
      video.muted = !video.muted;
    });
  };

  const setSpeed = (rate: number) => {
    setPlaybackRate(rate);
    withVideo((video) => {
      video.playbackRate = rate;
    });
  };

  const defaultAudioId =
    audioTracks.find((track) => track.default)?.id ??
    audioTracks[0]?.id ??
    null;
  const activeAudioId = selectedAudioId ?? defaultAudioId;

  const applyStreamSettings = (
    next: StreamSettings,
    onSuccess: () => void,
  ) => {
    void onStreamSettingsChange(next)
      .then(() => {
        onSuccess();
      })
      .catch(() => {
        // WatchPage surfaces the failure; keep the previous highlights.
      });
  };

  const selectQuality = (next: QualityId) => {
    if (next === selectedQuality) {
      return;
    }
    applyStreamSettings(
      {
        quality: next,
        audioStreamId: selectedAudioId,
        subtitleStreamId: selectedSubtitleId,
      },
      () => {
        setSelectedQuality(next);
      },
    );
  };

  const selectAudio = (next: string) => {
    if (next === activeAudioId) {
      return;
    }
    applyStreamSettings(
      {
        quality: selectedQuality,
        audioStreamId: next,
        subtitleStreamId: selectedSubtitleId,
      },
      () => {
        setSelectedAudioId(next);
      },
    );
  };

  const selectSubtitle = (next: string) => {
    const nextId = next === "" ? null : next;
    if (nextId === selectedSubtitleId) {
      return;
    }
    applyStreamSettings(
      {
        quality: selectedQuality,
        audioStreamId: selectedAudioId,
        subtitleStreamId: nextId,
      },
      () => {
        setSelectedSubtitleId(nextId);
      },
    );
  };

  const audioOptions = audioTracks.map((track) => ({
    value: track.id,
    label: formatAudioLabel(track),
  }));

  const subtitleOptions = [
    { value: "", label: "Off" },
    ...subtitleTracks.map((track) => ({
      value: track.id,
      label: formatSubtitleLabel(track),
    })),
  ];

  const toggleFullscreen = () => {
    const shell = shellRef.current;
    if (shell === null) {
      return;
    }
    if (document.fullscreenElement === shell) {
      void document.exitFullscreen().catch((err: unknown) => {
        console.error("Exit fullscreen failed", err);
      });
      return;
    }
    void shell.requestFullscreen().catch((err: unknown) => {
      console.error("Fullscreen request failed", err);
    });
  };

  const onShellKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== " " && event.code !== "Space") {
      return;
    }
    const tag = (event.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "BUTTON" || tag === "TEXTAREA") {
      return;
    }
    event.preventDefault();
    togglePlay();
  };

  const total = duration > 0 ? duration : fallbackDuration;
  const progressMax = total > 0 ? total : 0;
  const progressValue = Math.min(
    currentTime,
    progressMax > 0 ? progressMax : currentTime,
  );

  return (
    <div
      ref={shellRef}
      className={
        controlsVisible
          ? "watch-player-shell"
          : "watch-player-shell watch-player-shell--idle"
      }
      tabIndex={0}
      onPointerMove={revealControls}
      onKeyDown={onShellKeyDown}
    >
      <div
        ref={mediaRef}
        className="watch-player-media"
        onClick={onMediaClick}
      >
        {children}
      </div>

      {overlay}

      <div
        className={
          controlsVisible
            ? "watch-controls"
            : "watch-controls watch-controls--hidden"
        }
      >
        <div
          className="watch-settings"
          ref={settingsRef}
          hidden={!settingsOpen}
        >
          <h2 className="watch-settings-title">Settings</h2>
          <SettingsOptionGroup
            label="Speed"
            options={SPEED_OPTIONS}
            value={playbackRate}
            onChange={setSpeed}
          />
          <SettingsOptionGroup
            label="Quality"
            options={QUALITY_OPTIONS}
            value={selectedQuality}
            onChange={selectQuality}
          />
          {audioOptions.length > 0 ? (
            <SettingsOptionGroup
              label="Audio"
              options={audioOptions}
              value={activeAudioId ?? ""}
              onChange={selectAudio}
            />
          ) : null}
          {subtitleTracks.length > 0 ? (
            <SettingsOptionGroup
              label="Subtitles"
              options={subtitleOptions}
              value={selectedSubtitleId ?? ""}
              onChange={selectSubtitle}
            />
          ) : null}
          {autoPlay !== undefined && onAutoPlayChange !== undefined ? (
            <div className="watch-settings-group">
              <label className="watch-settings-toggle">
                <span className="watch-settings-toggle-text">Auto Play</span>
                <input
                  type="checkbox"
                  checked={autoPlay}
                  onChange={(event) => {
                    onAutoPlayChange(event.currentTarget.checked);
                  }}
                />
              </label>
            </div>
          ) : null}
        </div>

        <div className="watch-controls-bar">
          <button
            type="button"
            className="watch-control-btn"
            aria-label={playing ? "Pause" : "Play"}
            onClick={togglePlay}
          >
            {playing ? <IconPause /> : <IconPlay />}
          </button>

          <span className="watch-time" aria-hidden="true">
            {formatTime(currentTime)} / {formatTime(total)}
          </span>

          <label className="watch-seek">
            <span className="visually-hidden">Seek</span>
            <input
              type="range"
              min={0}
              max={progressMax || 1}
              step={0.1}
              value={progressValue}
              disabled={progressMax <= 0}
              aria-label="Seek"
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(total)}`}
              onPointerDown={() => {
                scrubbingRef.current = true;
              }}
              onPointerUp={(event) => {
                scrubbingRef.current = false;
                withVideo((video) => {
                  video.currentTime = Number(event.currentTarget.value);
                });
              }}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                setCurrentTime(next);
                if (!scrubbingRef.current) {
                  withVideo((video) => {
                    video.currentTime = next;
                  });
                }
              }}
              onInput={(event) => {
                setCurrentTime(Number(event.currentTarget.value));
              }}
            />
          </label>

          <button
            type="button"
            className="watch-control-btn"
            aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
            onClick={toggleMute}
          >
            {muted || volume === 0 ? <IconVolumeMuted /> : <IconVolume />}
          </button>

          <label className="watch-volume">
            <span className="visually-hidden">Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                withVideo((video) => {
                  video.volume = next;
                  if (next > 0 && video.muted) {
                    video.muted = false;
                  }
                });
              }}
            />
          </label>

          <button
            type="button"
            className="watch-control-btn"
            aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
          </button>

          <button
            type="button"
            className="watch-control-btn"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            ref={gearRef}
            onClick={() => {
              setSettingsOpen((open) => !open);
            }}
          >
            <IconGear />
          </button>
        </div>
      </div>
    </div>
  );
}

function formatAudioLabel(stream: AudioStream): string {
  const language =
    typeof stream.language === "string" && stream.language.trim() !== ""
      ? stream.language.trim()
      : "Unknown";
  const title =
    typeof stream.title === "string" && stream.title.trim() !== ""
      ? stream.title.trim()
      : null;
  const codec =
    typeof stream.codec === "string" && stream.codec.trim() !== ""
      ? stream.codec.trim()
      : null;
  const channels =
    typeof stream.channels === "number" ? `${stream.channels}ch` : null;
  const tech = [codec, channels].filter(Boolean).join(" ");
  const head = title !== null ? `${language} · ${title}` : language;
  return tech.length > 0 ? `${head} (${tech})` : head;
}

function formatSubtitleLabel(stream: SubtitleStream): string {
  const title =
    typeof stream.title === "string" && stream.title.trim() !== ""
      ? stream.title.trim()
      : null;
  const language =
    typeof stream.language === "string" && stream.language.trim() !== ""
      ? stream.language.trim()
      : null;
  const head = title ?? language ?? "Unknown";
  return stream.forced ? `${head} (forced)` : head;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h >= 1) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="currentColor" />
    </svg>
  );
}

function IconVolume() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5 9v6h4l5 4V5L9 9H5zm11.5 3a3.5 3.5 0 0 0-1.75-3.03v6.06A3.5 3.5 0 0 0 16.5 12zm0-7.5v2.06a6.5 6.5 0 0 1 0 10.88v2.06a8.5 8.5 0 0 0 0-15z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconVolumeMuted() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5 9v6h4l5 4V5L9 9H5zm11.41 3 2.12-2.12-1.41-1.41L15 10.59l-2.12-2.12-1.41 1.41L13.59 12l-2.12 2.12 1.41 1.41L15 13.41l2.12 2.12 1.41-1.41L16.41 12z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconFullscreen() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M7 14H5v5h5v-2H7v-3zm0-4h2V7h3V5H5v5h2zm10 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconFullscreenExit() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconGear() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.5a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.24.1.51 0 .64-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"
        fill="currentColor"
      />
    </svg>
  );
}
