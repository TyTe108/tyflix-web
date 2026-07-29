// The custom control bar for the watch page, replacing the browser's native
// <video controls>. Transport (play/pause, seek, volume, fullscreen), the
// settings gear (speed, quality, audio track, subtitles, auto-play), and the
// Cast button all live here.
//
// The <video> element itself is passed in as children and the parent owns the
// ref, so this component reads and writes an element it doesn't render.
// WatchPage is the only caller.
//
// Two things you can't guess from the code, and both cost real debugging time:
//
// 1. Quality and audio aren't client-side settings. Each change asks Plex for a
//    fresh transcode through onStreamSettingsChange, and WatchPage swaps the
//    descriptor in place so the <video> node stays mounted through the restart.
//    Unmount it and playback breaks. Speed is the exception: a plain
//    playbackRate write with no server round trip.
//
// 2. Plex burns subtitles into the video. They aren't a sidecar text track, so
//    choosing one means a PUT that sets the subtitle stream on the media part
//    followed by that same transcode restart. The Subtitles group looks
//    identical to Quality up here, but the plumbing behind it is different.
//
// While a Cast session is live the bar reads and writes the receiver (the
// `remote` prop) instead of the local element, and hides the controls that only
// make sense on this machine.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { AudioStream, SubtitleStream } from "../api/watch";
import type { RemotePlaybackControl } from "../cast/useCastPlayer";
import { useCastState } from "../cast/useCastState";

// Labels for the Quality group. WatchPage turns each one into the bitrate and
// resolution caps it sends to Plex; "original" means send no caps at all.
export type QualityId = "original" | "1080p" | "720p" | "480p";

// The full picked-stream state, sent to the parent as one object on every
// change. It's a whole snapshot rather than a delta because switching any one
// of these rebuilds the transcode, and the other two have to ride along.
export type StreamSettings = {
  quality: QualityId;
  audioStreamId: string | null; // null = let Plex pick its default track
  subtitleStreamId: string | null; // null = subtitles off
};

type PlayerControlsProps = {
  /** Points at the <video> passed in as children. The parent owns it. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Plex's runtime, used as the seek bar's total until the media reports one. */
  durationMs: number | null;
  audioTracks: AudioStream[];
  subtitleTracks: SubtitleStream[];
  /**
   * Applies a new stream selection. Rejecting leaves the current highlights
   * alone, which is how a failed switch avoids lying about what's playing.
   */
  onStreamSettingsChange: (settings: StreamSettings) => Promise<void>;
  /** Both auto-play props are undefined for movies, so the toggle hides. */
  autoPlay?: boolean;
  onAutoPlayChange?: (value: boolean) => void;
  /** When active, the bar reads/writes the Cast receiver instead of <video>. */
  remote?: RemotePlaybackControl;
  /** Cards drawn over the video: Up Next, resume prompt, cast status. */
  overlay?: ReactNode;
  children: ReactNode;
};

/** Unified read model for whichever target currently owns the control bar. */
type PlaybackTarget = {
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
};

// Idle time before the bar fades out during local playback.
const HIDE_DELAY_MS = 3000;

// Speed is applied straight to video.playbackRate, so these never reach Plex.
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

// One labelled row of pick-one buttons in the settings panel. Every group in
// the panel (Speed, Quality, Audio, Subtitles) is an instance of this, so the
// visual weight of a choice says nothing about how much work it costs.
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

/**
 * Wraps the player: renders the video (as children), any overlay cards, and the
 * control bar underneath.
 *
 * Whichever target is live owns the readouts. Local playback comes from
 * `<video>` events; a connected Cast receiver comes from `remote`. Everything
 * the bar displays flows through the `target` object below so the JSX never has
 * to ask which one it's talking to.
 *
 * Quality, audio and subtitle picks go out through `onStreamSettingsChange` and
 * only update their highlight once that promise resolves, so the panel never
 * shows a setting Plex refused.
 */
export function PlayerControls({
  videoRef,
  durationMs,
  audioTracks,
  subtitleTracks,
  onStreamSettingsChange,
  autoPlay,
  onAutoPlayChange,
  remote,
  overlay,
  children,
}: PlayerControlsProps) {
  // shell is the fullscreen target and the keyboard root; the other three back
  // the outside-click logic that decides whether a pointerdown closes settings.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const gearRef = useRef<HTMLButtonElement | null>(null);
  const mediaRef = useRef<HTMLDivElement | null>(null);
  const scrubbingRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // These three mirror state into refs so the long-lived <video> listeners read
  // current values without the effect rebinding on every change.
  const settingsOpenRef = useRef(false);
  const playbackRateRef = useRef(1);
  const remoteActiveRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const cast = useCastState();
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

  const remoteActive = remote?.isActive === true;
  remoteActiveRef.current = remoteActive;

  // Prefer the remote when casting; otherwise the local <video> state.
  // While scrubbing, keep the local currentTime preview even if remote is active.
  const target: PlaybackTarget = remoteActive
    ? {
        playing: remote.playing,
        currentTime: scrubbingRef.current ? currentTime : remote.currentTime,
        duration: remote.duration,
        volume: remote.volume,
        muted: remote.muted,
      }
    : {
        playing,
        currentTime,
        duration,
        volume,
        muted,
      };

  // Plex's reported runtime in seconds. Stands in any time the media element
  // has no finite duration of its own, which keeps the seek bar usable.
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

  // Arms the auto-hide countdown. Bails out and pins the bar whenever hiding it
  // would be wrong: casting, paused, or the settings panel is open.
  const scheduleHide = () => {
    clearHideTimer();
    // While casting there is no local video to reveal — keep controls on screen.
    if (remoteActiveRef.current) {
      setControlsVisible(true);
      return;
    }
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

  // Mirrors the local <video> into component state: play/pause, clock, volume,
  // rate. The dependency list is videoRef alone, so these listeners stay bound
  // across a quality or audio restart. WatchPage holds the same element mounted
  // through that swap, so there's nothing to rebind to. Every handler no-ops
  // while a Cast session owns playback.
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
      // Remote owns the UI while casting — don't let a torn-down <video> fight it.
      if (remoteActiveRef.current) {
        return;
      }
      setPlaying(!video.paused);
      if (video.paused || settingsOpenRef.current) {
        setControlsVisible(true);
        clearHideTimer();
      } else {
        scheduleHide();
      }
    };
    // While a drag is in flight, currentTime belongs to the thumb, not the
    // element. Writing it here would yank the handle back under the cursor.
    const onTime = () => {
      if (remoteActiveRef.current) {
        return;
      }
      if (!scrubbingRef.current) {
        setCurrentTime(video.currentTime);
      }
      setDuration(resolveDuration());
    };
    const onVolume = () => {
      if (remoteActiveRef.current) {
        return;
      }
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onEnded = () => {
      if (remoteActiveRef.current) {
        return;
      }
      setPlaying(false);
      setControlsVisible(true);
      clearHideTimer();
    };
    const onRateChange = () => {
      if (remoteActiveRef.current) {
        return;
      }
      setPlaybackRate(video.playbackRate);
    };
    // Re-apply the chosen rate after a source reload (e.g. future quality
    // restart) so the browser's default 1× does not silently win.
    const onLoadedMetadata = () => {
      if (remoteActiveRef.current) {
        return;
      }
      video.playbackRate = playbackRateRef.current;
      onTime();
    };

    // Seed from the element before subscribing. If it's already playing when
    // this binds, no event is coming to tell us.
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

  // Keep controls pinned while casting (no local picture to free up).
  useEffect(() => {
    if (!remoteActive) {
      return;
    }
    setControlsVisible(true);
    clearHideTimer();
  }, [remoteActive]);

  // On cast disconnect, re-seed UI from the local <video> so we don't keep
  // showing the last remote snapshot through the local state branch.
  useEffect(() => {
    if (remoteActive) {
      return;
    }
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    setPlaying(!video.paused);
    if (!scrubbingRef.current) {
      setCurrentTime(video.currentTime);
    }
    setDuration(
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : fallbackDurationRef.current,
    );
    setVolume(video.volume);
    setMuted(video.muted);
    if (video.paused || settingsOpenRef.current) {
      setControlsVisible(true);
      clearHideTimer();
    } else {
      scheduleHide();
    }
  }, [remoteActive, videoRef]);

  // Track fullscreen from the document rather than from our own button, so
  // Escape and the browser's own controls keep the icon honest. Only counts as
  // fullscreen when it's our shell that went fullscreen, not some other element.
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

  // Dismiss the settings panel on an outside click, and hold the bar visible
  // for as long as the panel is open. Runs on every open/close.
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

  // Don't leave a hide timer running after unmount.
  useEffect(() => {
    return () => {
      clearHideTimer();
    };
  }, []);

  // Null-guard for the local element, so every transport handler below is one
  // branch (remote or local) instead of two nested checks.
  const withVideo = (fn: (video: HTMLVideoElement) => void) => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    fn(video);
  };

  // The transport handlers all follow the same shape: hand off to the Cast
  // receiver when one is connected, otherwise drive the local element.
  const togglePlay = () => {
    if (remoteActive && remote) {
      remote.playOrPause();
      return;
    }
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

  // Click on the picture. With settings open the first click only closes the
  // panel, so you don't pause the film on your way out of the menu.
  const onMediaClick = () => {
    if (settingsOpenRef.current) {
      setSettingsOpen(false);
      return;
    }
    togglePlay();
  };

  const toggleMute = () => {
    if (remoteActive && remote) {
      remote.muteOrUnmute();
      return;
    }
    withVideo((video) => {
      video.muted = !video.muted;
    });
  };

  const seekTo = (seconds: number) => {
    if (remoteActive && remote) {
      remote.seek(seconds);
      return;
    }
    withVideo((video) => {
      video.currentTime = seconds;
    });
  };

  // Dragging the slider up off zero also unmutes, on either target. Otherwise
  // you'd move the slider and still hear nothing.
  const setVolumeLevel = (level: number) => {
    if (remoteActive && remote) {
      if (level > 0 && remote.muted) {
        remote.muteOrUnmute();
      }
      remote.setVolumeLevel(level);
      return;
    }
    withVideo((video) => {
      video.volume = level;
      if (level > 0 && video.muted) {
        video.muted = false;
      }
    });
  };

  // The one setting that stays entirely in the browser. No Plex round trip, no
  // transcode restart. There's no remote equivalent, so it's a no-op casting.
  const setSpeed = (rate: number) => {
    if (remoteActive) {
      return;
    }
    setPlaybackRate(rate);
    withVideo((video) => {
      video.playbackRate = rate;
    });
  };

  // Nothing is selected until the user picks, so the highlighted audio row is
  // whatever Plex flags as default, falling back to the first track listed.
  const defaultAudioId =
    audioTracks.find((track) => track.default)?.id ??
    audioTracks[0]?.id ??
    null;
  const activeAudioId = selectedAudioId ?? defaultAudioId;

  // Shared path for the three settings that cost a transcode restart. The
  // highlight only moves after the parent's promise resolves, so a stream that
  // failed to switch keeps showing the setting that's actually playing.
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

  // Resolution and bitrate cap. WatchPage turns the id into Plex tuning params
  // and refetches the stream, keeping the <video> element mounted throughout.
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

  // Audio track, commentary included. Same restart cost as quality: Plex has to
  // re-decide the stream, which means a new transcode session.
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

  // Subtitles. The empty-string option is "Off", which the parent translates to
  // Plex's clear-selection value. Underneath, this is the two-step one: a PUT
  // that sets the subtitle stream on the media part, then the transcode restart
  // that burns it into the picture. There's no sidecar track to toggle.
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

  // "Off" is prepended rather than coming from Plex, and carries the empty
  // string that selectSubtitle reads as null.
  const subtitleOptions = [
    { value: "", label: "Off" },
    ...subtitleTracks.map((track) => ({
      value: track.id,
      label: formatSubtitleLabel(track),
    })),
  ];

  // Fullscreens the whole shell, not the <video>, so the bar and any overlay
  // card come along instead of being clipped out by the native video view.
  const toggleFullscreen = () => {
    if (remoteActive) {
      return;
    }
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

  // Space toggles playback, but not when focus sits on a control that already
  // means something by Space (buttons, the sliders, any input).
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

  // Seek bar geometry. The value gets clamped to the track so the thumb can't
  // run past the end when the clock and the duration disagree.
  const total = target.duration > 0 ? target.duration : fallbackDuration;
  const progressMax = total > 0 ? total : 0;
  const progressValue = Math.min(
    target.currentTime,
    progressMax > 0 ? progressMax : target.currentTime,
  );

  return (
    // Shell: fullscreen target, keyboard root, and the surface whose idle class
    // fades the bar out. tabIndex makes it focusable so Space reaches us.
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
      {/* The <video> the parent passed in. We never render it ourselves. */}
      <div
        ref={mediaRef}
        className="watch-player-media"
        onClick={onMediaClick}
      >
        {children}
      </div>

      {/* Cast status, resume prompt, Up Next. Composed by WatchPage. */}
      {overlay}

      <div
        className={
          controlsVisible
            ? "watch-controls"
            : "watch-controls watch-controls--hidden"
        }
      >
        {/* Settings panel. Always in the tree, toggled with `hidden` rather
            than unmounted. Each group only renders when it has something to
            offer, so a title with no subtitle streams shows no Subtitles row. */}
        <div
          className="watch-settings"
          ref={settingsRef}
          hidden={!settingsOpen}
        >
          <h2 className="watch-settings-title">Settings</h2>
          {/* Speed is a local-only setting, so it drops off while casting. */}
          {!remoteActive ? (
            <SettingsOptionGroup
              label="Speed"
              options={SPEED_OPTIONS}
              value={playbackRate}
              onChange={setSpeed}
            />
          ) : null}
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
          {/* Auto Play drives the Up Next advance, so WatchPage only passes
              these props for episodes. Movies have nothing to advance to. */}
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

        {/* The bar itself: play, clock, seek, volume, fullscreen, cast, gear. */}
        <div className="watch-controls-bar">
          <button
            type="button"
            className="watch-control-btn"
            aria-label={target.playing ? "Pause" : "Play"}
            onClick={togglePlay}
          >
            {target.playing ? <IconPause /> : <IconPlay />}
          </button>

          {/* Hidden from screen readers; the seek slider's aria-valuetext
              already announces the same position. */}
          <span className="watch-time" aria-hidden="true">
            {formatTime(target.currentTime)} / {formatTime(total)}
          </span>

          {/* Seek. onPointerDown latches scrubbingRef, which stops the clock
              from writing over the thumb mid-drag, and the real seek only
              fires on release. onChange still seeks directly for keyboard
              users, who never set the latch. */}
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
              aria-valuetext={`${formatTime(target.currentTime)} of ${formatTime(total)}`}
              onPointerDown={() => {
                scrubbingRef.current = true;
                if (remoteActive && remote) {
                  setCurrentTime(remote.currentTime);
                }
              }}
              onPointerUp={(event) => {
                scrubbingRef.current = false;
                seekTo(Number(event.currentTarget.value));
              }}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                setCurrentTime(next);
                if (!scrubbingRef.current) {
                  seekTo(next);
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
            aria-label={
              target.muted || target.volume === 0 ? "Unmute" : "Mute"
            }
            onClick={toggleMute}
          >
            {target.muted || target.volume === 0 ? (
              <IconVolumeMuted />
            ) : (
              <IconVolume />
            )}
          </button>

          <label className="watch-volume">
            <span className="visually-hidden">Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={target.muted ? 0 : target.volume}
              aria-label="Volume"
              onChange={(event) => {
                setVolumeLevel(Number(event.currentTarget.value));
              }}
            />
          </label>

          {/* Nothing to enlarge while the TV has the picture. */}
          {!remoteActive ? (
            <button
              type="button"
              className="watch-control-btn"
              aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={toggleFullscreen}
            >
              {fullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
            </button>
          ) : null}

          {/* Cast button. Hidden outright where the framework isn't there,
              which is every non-Chromium browser. */}
          {cast.available ? (
            <button
              type="button"
              className={
                cast.connected
                  ? "watch-control-btn watch-control-btn--cast-active"
                  : "watch-control-btn"
              }
              aria-label={cast.connected ? "Stop casting" : "Cast"}
              aria-pressed={cast.connected}
              onClick={cast.toggle}
            >
              <IconCast />
            </button>
          ) : null}

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

// Builds an audio row label like "English · Director's Commentary (ac3 6ch)".
// Plex fills these fields in unevenly, so every piece is optional and the
// language falls back to "Unknown" rather than leaving a blank button.
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

// Subtitle row label. Prefers the track's own title over its language, since a
// title is usually the more specific of the two, and tags forced tracks.
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

// Clock readout, h:mm:ss once past an hour and m:ss below it. A NaN duration is
// normal before metadata lands, so that reads as 0:00 instead of leaking through.
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

// Inline icons from here down, all filled with currentColor so they pick up
// whatever the surrounding button is coloured. No icon library in the app.
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

function IconCast() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"
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
