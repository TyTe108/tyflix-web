import { useEffect, useRef, useState } from "react";
import { subscribeCastReady } from "./initCast";

/**
 * Playback state + commands for the Cast receiver. When `isActive` is true,
 * the in-app control bar should drive this instead of the local <video>.
 */
export type RemotePlaybackControl = {
  isActive: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  /** Friendly name of the connected Cast device, if known. */
  deviceName: string | null;
  playOrPause: () => void;
  seek: (seconds: number) => void;
  setVolumeLevel: (level: number) => void;
  muteOrUnmute: () => void;
};

type RemotePlayerSnapshot = {
  isActive: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  deviceName: string | null;
};

const IDLE_SNAPSHOT: RemotePlayerSnapshot = {
  isActive: false,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  deviceName: null,
};

function isChromiumFamily(): boolean {
  return typeof window.chrome === "object" && window.chrome !== null;
}

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

/** Resolve event types from the live SDK — call only after framework is present. */
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

export function useCastPlayer(): RemotePlaybackControl {
  const [snapshot, setSnapshot] = useState<RemotePlayerSnapshot>(IDLE_SNAPSHOT);
  const playerRef = useRef<cast.framework.RemotePlayer | null>(null);
  const controllerRef = useRef<cast.framework.RemotePlayerController | null>(
    null,
  );

  useEffect(() => {
    if (!isChromiumFamily()) {
      setSnapshot(IDLE_SNAPSHOT);
      return;
    }

    let attached = false;
    let watchedEvents: cast.framework.RemotePlayerEventType[] = [];

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

  return {
    ...snapshot,
    playOrPause,
    seek,
    setVolumeLevel,
    muteOrUnmute,
  };
}
