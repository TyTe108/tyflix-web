// Hand-written ambient types for the Google Cast Application Framework (CAF)
// web sender SDK.
//
// There's no npm package behind any of this. initCast.ts injects Google's
// cast_sender.js from gstatic at runtime, so `cast.framework` and `chrome.cast`
// turn up as bare globals with no type information attached. Everything below
// is a hand-declared mirror of the runtime API, covering only the surface the
// other five files in this directory actually touch. Widen it when a later
// increment needs more.
//
// The `Window` block near the bottom is load-bearing, not decoration.
// __onGCastApiAvailable is the callback the SDK invokes once it's finished
// loading, and initCast installs it before the script tag so the announcement
// can't be missed.
//
// Nothing here emits. A declaration that drifts from the real SDK still
// compiles clean and then fails on someone's TV, so treat a mismatch as a real
// defect rather than a typing nit.

declare namespace chrome.cast {
  // Runtime enum provided by the CAF sender SDK (not emitted by us).
  // Governs whether an existing session gets picked back up automatically.
  // initCast sets ORIGIN_SCOPED.
  enum AutoJoinPolicy {
    TAB_AND_ORIGIN_SCOPED = "tab_and_origin_scoped",
    ORIGIN_SCOPED = "origin_scoped",
    PAGE_SCOPED = "page_scoped",
  }

  // The device on the other end. useCastPlayer reads friendlyName to put the
  // TV's name in the "Playing on ..." overlay.
  interface Receiver {
    friendlyName: string;
  }

  // The media-load half of the API. loadMediaOnCast is the only caller.
  namespace media {
    // App id of Google's stock receiver, set as the receiverApplicationId in
    // initCast.
    const DEFAULT_MEDIA_RECEIVER_APP_ID: string;

    enum StreamType {
      BUFFERED = "buffered",
      LIVE = "live",
      OTHER = "other",
    }

    // What the receiver puts on screen while it loads and plays. Two lines,
    // filled from the same title and subheading the watch page prints in its
    // own header.
    class GenericMediaMetadata {
      title?: string;
      subtitle?: string;
    }

    // contentId is the manifest URL, contentType its MIME type. For this app
    // that's Plex's start.mpd and "application/dash+xml".
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

// The framework half of the SDK, the one this app is written against. Two
// parallel state machines live in here and it matters which you listen to:
// CastState is about the sender's connection to a device, SessionState is about
// the receiver app running on it. useCastState follows the first,
// subscribeSessionReady the second.
declare namespace cast.framework {
  enum CastContextEventType {
    CAST_STATE_CHANGED = "caststatechanged",
    SESSION_STATE_CHANGED = "sessionstatechanged",
  }

  // Connection-level state. Only CONNECTED is ever compared against; the rest
  // are here so the enum matches the SDK.
  enum CastState {
    NO_DEVICES_AVAILABLE = "NO_DEVICES_AVAILABLE",
    NOT_CONNECTED = "NOT_CONNECTED",
    CONNECTING = "CONNECTING",
    CONNECTED = "CONNECTED",
  }

  // Receiver-app state. SESSION_STARTED and SESSION_RESUMED are the two that
  // mean "ready for a loadMedia call"; see subscribeSessionReady.
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
    session: CastSession | null; // null is possible even on a live state
  }

  class CastSession {
    loadMedia(request: chrome.cast.media.LoadRequest): Promise<unknown>;
    // Null until the receiver has actually taken the media. WatchPage polls it
    // after a load to decide whether the attempt silently went nowhere.
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

  // A live, mutable view of what the TV is doing. The SDK writes these fields
  // in place, so you read the object rather than the event payload. currentTime
  // and duration are seconds, volumeLevel is 0 to 1. useCastPlayer copies the
  // whole thing into React state on every change.
  class RemotePlayer {
    isConnected: boolean;
    isMediaLoaded: boolean;
    isPaused: boolean;
    currentTime: number;
    duration: number;
    volumeLevel: number;
    isMuted: boolean;
  }

  // Which field changed and its new value. useCastPlayer ignores both and
  // re-reads the player, so nothing here is load-bearing today.
  interface RemotePlayerChangedEvent {
    field: string;
    value: unknown;
  }

  // The write side of RemotePlayer, and the API shape most likely to confuse
  // someone new. seek() and setVolumeLevel() take no arguments: you assign the
  // value onto the RemotePlayer first, then call the matching method to push it
  // to the device. useCastPlayer does exactly that.
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

  // Process-wide singleton and the entry point for everything else. initCast
  // configures it once; every other file reaches it through getInstance().
  // addEventListener is overloaded per event type so the handler's event
  // argument comes out correctly typed at each call site.
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
    // Opens the browser's device picker. Rejects with an error code string,
    // including a plain "cancel" when the user just closes the picker.
    requestSession(): Promise<string | null>;
    // stopCasting true tells the receiver to stop as well, rather than leaving
    // the TV playing after the sender lets go.
    endCurrentSession(stopCasting: boolean): void;
  }
}

// The globals the SDK actually installs, as opposed to the namespaces above.
// These stay optional because feature detection is how the app decides whether
// Cast exists at all: `window.chrome` is the Chromium check, `window.cast`
// means the framework has finished loading.
interface Window {
  chrome?: object;
  cast?: {
    framework: typeof cast.framework;
  };
  // The SDK's readiness announcement, and the reason initCast has to install a
  // handler before injecting the script. `reason` carries a short explanation
  // when isAvailable is false.
  __onGCastApiAvailable?: (
    isAvailable: boolean,
    reason?: string,
  ) => void;
}

// Bare-identifier forms, so `cast.framework.CastContext` and
// `chrome.cast.media` type-check without going through `window.` first. Guard
// these with the optional `window` properties above before use, because the
// declarations promise they exist and the runtime doesn't.
declare const chrome: {
  cast: typeof chrome.cast;
};

declare const cast: {
  framework: typeof cast.framework;
};
