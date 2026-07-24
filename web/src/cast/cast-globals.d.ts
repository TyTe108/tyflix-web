/**
 * Minimal ambient types for the CAF web sender SDK loaded from gstatic.
 * Only the surface used by initCast / useCastState — expand as later
 * cast increments need it.
 */

declare namespace chrome.cast {
  // Runtime enum provided by the CAF sender SDK (not emitted by us).
  enum AutoJoinPolicy {
    TAB_AND_ORIGIN_SCOPED = "tab_and_origin_scoped",
    ORIGIN_SCOPED = "origin_scoped",
    PAGE_SCOPED = "page_scoped",
  }

  namespace media {
    const DEFAULT_MEDIA_RECEIVER_APP_ID: string;
  }
}

declare namespace cast.framework {
  enum CastContextEventType {
    CAST_STATE_CHANGED = "caststatechanged",
  }

  enum CastState {
    NO_DEVICES_AVAILABLE = "NO_DEVICES_AVAILABLE",
    NOT_CONNECTED = "NOT_CONNECTED",
    CONNECTING = "CONNECTING",
    CONNECTED = "CONNECTED",
  }

  interface CastOptions {
    receiverApplicationId: string;
    autoJoinPolicy?: chrome.cast.AutoJoinPolicy;
  }

  interface CastStateEventData {
    castState: CastState;
  }

  type CastContextEventHandler = (event: CastStateEventData) => void;

  class CastContext {
    static getInstance(): CastContext;
    setOptions(options: CastOptions): void;
    getCastState(): CastState;
    addEventListener(
      type: CastContextEventType,
      handler: CastContextEventHandler,
    ): void;
    removeEventListener(
      type: CastContextEventType,
      handler: CastContextEventHandler,
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
