/**
 * Minimal ambient types for the CAF web sender SDK loaded from gstatic.
 * Only the surface used by initCast / useCastState / useCastPlayer /
 * loadMediaOnCast / subscribeSessionReady — expand as later cast increments
 * need it.
 */

declare namespace chrome.cast {
  // Runtime enum provided by the CAF sender SDK (not emitted by us).
  enum AutoJoinPolicy {
    TAB_AND_ORIGIN_SCOPED = "tab_and_origin_scoped",
    ORIGIN_SCOPED = "origin_scoped",
    PAGE_SCOPED = "page_scoped",
  }

  interface Receiver {
    friendlyName: string;
  }

  namespace media {
    const DEFAULT_MEDIA_RECEIVER_APP_ID: string;

    enum StreamType {
      BUFFERED = "buffered",
      LIVE = "live",
      OTHER = "other",
    }

    class GenericMediaMetadata {
      title?: string;
      subtitle?: string;
    }

    class MediaInfo {
      constructor(contentId: string, contentType: string);
      streamType: StreamType;
      metadata?: GenericMediaMetadata;
    }

    class LoadRequest {
      constructor(mediaInfo: MediaInfo);
      autoplay: boolean;
    }
  }
}

declare namespace cast.framework {
  enum CastContextEventType {
    CAST_STATE_CHANGED = "caststatechanged",
    SESSION_STATE_CHANGED = "sessionstatechanged",
  }

  enum CastState {
    NO_DEVICES_AVAILABLE = "NO_DEVICES_AVAILABLE",
    NOT_CONNECTED = "NOT_CONNECTED",
    CONNECTING = "CONNECTING",
    CONNECTED = "CONNECTED",
  }

  enum SessionState {
    NO_SESSION = "NO_SESSION",
    SESSION_STARTING = "SESSION_STARTING",
    SESSION_STARTED = "SESSION_STARTED",
    SESSION_START_FAILED = "SESSION_START_FAILED",
    SESSION_ENDING = "SESSION_ENDING",
    SESSION_ENDED = "SESSION_ENDED",
    SESSION_RESUMED = "SESSION_RESUMED",
  }

  interface CastOptions {
    receiverApplicationId: string;
    autoJoinPolicy?: chrome.cast.AutoJoinPolicy;
  }

  interface CastStateEventData {
    castState: CastState;
  }

  interface SessionStateEventData {
    sessionState: SessionState;
    session: CastSession | null;
  }

  class CastSession {
    loadMedia(request: chrome.cast.media.LoadRequest): Promise<unknown>;
    getMediaSession(): object | null;
    getCastDevice(): chrome.cast.Receiver;
  }

  enum RemotePlayerEventType {
    IS_CONNECTED_CHANGED = "isConnectedChanged",
    IS_MEDIA_LOADED_CHANGED = "isMediaLoadedChanged",
    IS_PAUSED_CHANGED = "isPausedChanged",
    CURRENT_TIME_CHANGED = "currentTimeChanged",
    DURATION_CHANGED = "durationChanged",
    VOLUME_LEVEL_CHANGED = "volumeLevelChanged",
    IS_MUTED_CHANGED = "isMutedChanged",
  }

  class RemotePlayer {
    isConnected: boolean;
    isMediaLoaded: boolean;
    isPaused: boolean;
    currentTime: number;
    duration: number;
    volumeLevel: number;
    isMuted: boolean;
  }

  interface RemotePlayerChangedEvent {
    field: string;
    value: unknown;
  }

  class RemotePlayerController {
    constructor(player: RemotePlayer);
    addEventListener(
      type: RemotePlayerEventType,
      handler: (event: RemotePlayerChangedEvent) => void,
    ): void;
    removeEventListener(
      type: RemotePlayerEventType,
      handler: (event: RemotePlayerChangedEvent) => void,
    ): void;
    playOrPause(): void;
    seek(): void;
    setVolumeLevel(): void;
    muteOrUnmute(): void;
  }

  class CastContext {
    static getInstance(): CastContext;
    setOptions(options: CastOptions): void;
    getCastState(): CastState;
    getSessionState(): SessionState;
    getCurrentSession(): CastSession | null;
    addEventListener(
      type: CastContextEventType.CAST_STATE_CHANGED,
      handler: (event: CastStateEventData) => void,
    ): void;
    addEventListener(
      type: CastContextEventType.SESSION_STATE_CHANGED,
      handler: (event: SessionStateEventData) => void,
    ): void;
    removeEventListener(
      type: CastContextEventType.CAST_STATE_CHANGED,
      handler: (event: CastStateEventData) => void,
    ): void;
    removeEventListener(
      type: CastContextEventType.SESSION_STATE_CHANGED,
      handler: (event: SessionStateEventData) => void,
    ): void;
    requestSession(): Promise<string | null>;
    endCurrentSession(stopCasting: boolean): void;
  }
}

interface Window {
  chrome?: object;
  cast?: {
    framework: typeof cast.framework;
  };
  __onGCastApiAvailable?: (
    isAvailable: boolean,
    reason?: string,
  ) => void;
}

declare const chrome: {
  cast: typeof chrome.cast;
};

declare const cast: {
  framework: typeof cast.framework;
};
