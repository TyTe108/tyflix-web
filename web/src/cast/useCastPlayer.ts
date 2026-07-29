// Mirrors what the TV is doing into React state, and exposes the four commands
// the control bar needs to drive it.
//
// WatchPage calls this once and passes the result straight down to
// PlayerControls as its `remote` prop. While isActive is true, the same
// scrubber, play button and volume slider write to the Chromecast instead of
// the local <video>, so the UI doesn't change shape when playback moves rooms.
// Nothing in this file talks to Plex or to Tyflix's API. It's a wrapper over
// CAF's RemotePlayer plus its RemotePlayerController, and no more.
//
// Two things upstream lean on the numbers coming out of here. WatchPage runs a
// second timeline reporter off currentTime while casting, so a session on the
// TV updates watched state and resume position in Plex exactly like local
// playback does. It also latches the last position it saw, and when the cast
// session ends the browser picks the title back up wherever the TV got to.
//
// The SDK's own shape is the reason for the snapshot pattern below. RemotePlayer
// is a live object the SDK mutates in place, which React can't see, so every
// change event copies the whole thing into state.

import { useEffect, useRef, useState } from "react";
import { subscribeCastReady } from "./initCast";

/**
 * Playback state + commands for the Cast receiver. When `isActive` is true,
 * the in-app control bar should drive this instead of the local <video>.
 */
export type RemotePlaybackControl = {
  isActive: boolean;
  playing: boolean;
  currentTime: number; // seconds
  duration: number; // seconds, 0 when the receiver hasn't reported one yet
  volume: number; // 0 to 1, receiver volume and not the browser's
  muted: boolean;
  /** Friendly name of the connected Cast device, if known. */
  deviceName: string | null;
  playOrPause: () => void;
  seek: (seconds: number) => void;
  setVolumeLevel: (level: number) => void;
  muteOrUnmute: () => void;
};

// The state half of RemotePlaybackControl. Split out because the commands are
// stable wrappers and only these fields actually re-render anything.
type RemotePlayerSnapshot = {
  isActive: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  deviceName: string | null;
};

// What every consumer sees when there's no cast session: not casting, and
// numbers safe to render. volume sits at 1 so a control bar reading this before
// a session exists doesn't paint a muted slider.
const IDLE_SNAPSHOT: RemotePlayerSnapshot = {
  isActive: false,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  deviceName: null,
};

// Same cheap Chromium gate as useCastState and initCast, duplicated in each.
function isChromiumFamily(): boolean {
  return typeof window.chrome === "object" && window.chrome !== null;
}

// The TV's name, for the "Playing on Living Room" overlay. It comes off the
// session rather than the RemotePlayer, so it needs its own lookup, and the
// whole thing is best-effort: any missing piece just means the overlay says
// "your TV" instead.
function readDeviceName(): string | null {
  if (!window.cast?.framework) {
    return null;
  }
  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  if (session === null) {
    return null;
  }
  try {
    const name = session.getCastDevice().friendlyName;
    return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
  } catch {
    return null;
  }
}

// Copies the SDK's live player object into a plain immutable snapshot React can
// diff.
//
// Every field gets checked rather than trusted. These are plain properties the
// SDK writes whenever it likes, and they aren't all sane at every point in a
// session: WatchPage's cast timeline reporter carries its own note that
// disconnect can zero them out before cleanup runs. Bad values coerce to the
// idle defaults instead of reaching the control bar as NaN.
function readSnapshot(player: cast.framework.RemotePlayer): RemotePlayerSnapshot {
  const connected = player.isConnected === true;
  return {
    isActive: connected,
    playing: connected && !player.isPaused,
    currentTime:
      typeof player.currentTime === "number" && Number.isFinite(player.currentTime)
        ? player.currentTime
        : 0,
    duration:
      typeof player.duration === "number" &&
      Number.isFinite(player.duration) &&
      player.duration > 0
        ? player.duration
        : 0,
    volume:
      typeof player.volumeLevel === "number" && Number.isFinite(player.volumeLevel)
        ? Math.min(1, Math.max(0, player.volumeLevel))
        : 1,
    muted: player.isMuted === true,
    deviceName: connected ? readDeviceName() : null,
  };
}

/**
 * Resolve event types from the live SDK. Call only after framework is present.
 *
 * These are runtime enum members, so reading them before the gstatic script
 * lands throws. That's also why the list is built inside attach() rather than
 * as a module constant.
 */
function resolveWatchedEvents(): cast.framework.RemotePlayerEventType[] {
  const { RemotePlayerEventType: EventType } = cast.framework;
  return [
    EventType.IS_CONNECTED_CHANGED,
    EventType.IS_MEDIA_LOADED_CHANGED,
    EventType.IS_PAUSED_CHANGED,
    EventType.CURRENT_TIME_CHANGED,
    EventType.DURATION_CHANGED,
    EventType.VOLUME_LEVEL_CHANGED,
    EventType.IS_MUTED_CHANGED,
  ];
}

/**
 * Live receiver playback state plus the commands to change it.
 *
 * Returns IDLE_SNAPSHOT semantics wherever Cast can't run, so a caller can
 * render this unconditionally and branch on `isActive`. The RemotePlayer stays
 * attached for the life of the component, not just while a session is up:
 * isActive is what tells you whether the numbers mean anything.
 */
export function useCastPlayer(): RemotePlaybackControl {
  // Snapshot drives rendering. The refs hold the SDK objects, which must not
  // be state: they're mutated in place and reassigning them wouldn't re-render
  // anyway.
  const [snapshot, setSnapshot] = useState<RemotePlayerSnapshot>(IDLE_SNAPSHOT);
  const playerRef = useRef<cast.framework.RemotePlayer | null>(null);
  const controllerRef = useRef<cast.framework.RemotePlayerController | null>(
    null,
  );

  // Runs once per mount. Waits on the SDK, builds a RemotePlayer, and keeps
  // snapshot in step with it until unmount.
  useEffect(() => {
    if (!isChromiumFamily()) {
      setSnapshot(IDLE_SNAPSHOT);
      return;
    }

    let attached = false;
    let watchedEvents: cast.framework.RemotePlayerEventType[] = [];

    // One handler for all seven events. The payload says which field changed
    // and to what, and it's ignored on purpose: re-reading the whole player is
    // simpler than merging seven partial updates, and it can't drift.
    const onPlayerChanged = () => {
      const player = playerRef.current;
      if (player === null) {
        return;
      }
      setSnapshot(readSnapshot(player));
    };

    const attach = () => {
      if (attached || !window.cast?.framework) {
        return;
      }
      try {
        // Resolve the event list before anything is assigned to a ref, so a
        // throw from the enum lookup leaves no half-built player behind.
        const events = resolveWatchedEvents();
        const player = new cast.framework.RemotePlayer();
        const controller = new cast.framework.RemotePlayerController(player);
        playerRef.current = player;
        controllerRef.current = controller;
        watchedEvents = events;
        for (const type of watchedEvents) {
          controller.addEventListener(type, onPlayerChanged);
        }
        attached = true;
        // Seed from the player as it stands. Attaching late into a session
        // that's already running is normal, and no event would arrive to
        // describe a state that stopped changing before we got here.
        setSnapshot(readSnapshot(player));
      } catch (err: unknown) {
        console.warn("[cast] Failed to initialize remote player.", err);
        playerRef.current = null;
        controllerRef.current = null;
        watchedEvents = [];
        setSnapshot(IDLE_SNAPSHOT);
      }
    };

    const unsubscribeReady = subscribeCastReady(attach);

    // Detach everything on unmount. The controller outlives the component
    // otherwise, and its listeners would keep calling setSnapshot on something
    // that's gone.
    return () => {
      unsubscribeReady();
      const controller = controllerRef.current;
      if (controller !== null) {
        for (const type of watchedEvents) {
          controller.removeEventListener(type, onPlayerChanged);
        }
      }
      playerRef.current = null;
      controllerRef.current = null;
      watchedEvents = [];
      attached = false;
    };
  }, []);

  // Shared guard for the four commands. Each one needs both refs, both can be
  // null (never attached, or already unmounted), and the SDK can throw if the
  // session drops mid-call. A failed command warns and does nothing rather than
  // taking the player down with it.
  const withController = (
    label: string,
    fn: (
      controller: cast.framework.RemotePlayerController,
      player: cast.framework.RemotePlayer,
    ) => void,
  ) => {
    const controller = controllerRef.current;
    const player = playerRef.current;
    if (controller === null || player === null) {
      console.warn(`[cast] Remote player unavailable for ${label}.`);
      return;
    }
    try {
      fn(controller, player);
    } catch (err: unknown) {
      console.warn(`[cast] Remote ${label} failed.`, err);
    }
  };

  // The four commands. Two of them show CAF's odd write pattern: there's no
  // seek(seconds) or setVolumeLevel(level), so the value gets assigned onto the
  // RemotePlayer first and the argument-less method pushes it to the device.
  const playOrPause = () => {
    withController("playOrPause", (controller) => {
      controller.playOrPause();
    });
  };

  const seek = (seconds: number) => {
    withController("seek", (controller, player) => {
      player.currentTime = seconds;
      controller.seek();
    });
  };

  const setVolumeLevel = (level: number) => {
    // Clamped here rather than trusted from the slider, since the SDK gets a
    // raw property assignment with nothing in between.
    withController("setVolumeLevel", (controller, player) => {
      player.volumeLevel = Math.min(1, Math.max(0, level));
      controller.setVolumeLevel();
    });
  };

  const muteOrUnmute = () => {
    withController("muteOrUnmute", (controller) => {
      controller.muteOrUnmute();
    });
  };

  // Snapshot fields plus the commands, flat, so PlayerControls can treat this
  // and the local <video> as the same shape.
  return {
    ...snapshot,
    playOrPause,
    seek,
    setVolumeLevel,
    muteOrUnmute,
  };
}
