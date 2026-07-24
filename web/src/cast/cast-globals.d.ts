/**
 * Minimal ambient types for the CAF web sender SDK loaded from gstatic.
 * Only the surface used by initCast — expand as later cast increments need it.
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
  interface CastOptions {
    receiverApplicationId: string;
    autoJoinPolicy?: chrome.cast.AutoJoinPolicy;
  }

  class CastContext {
    static getInstance(): CastContext;
    setOptions(options: CastOptions): void;
    getCastState(): string;
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
