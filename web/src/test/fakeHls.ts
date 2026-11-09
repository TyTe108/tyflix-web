// Fake hls.js for WatchPage playback tests.
//
// WatchPage imports this as the default export and calls isSupported, Events,
// the constructor, on, loadSource, attachMedia, startLoad, and destroy. Every
// instance is kept, in order, with the config it was given, the URL passed to
// loadSource, the element passed to attachMedia, each startLoad call in order,
// and a destroyed flag.
//
// What it copies from hls.js 1.6.16, and nothing else:
// attachMedia points the element at a MediaSource (dist/hls.mjs 18701-18715).
// When appendSource is true, which hls.js sets at 18553 for a
// ManagedMediaSource, that branch removes the media src and calls load()
// (18703-18709). Otherwise it sets media.src to the MediaSource object URL
// (18713-18715). Setting src also runs the media element load algorithm, so
// the reset through load() here stands for both branches.
// destroy goes through detachMedia, and the buffer controller then runs
// media.removeAttribute("src") and media.load() (dist/hls.mjs 18880-18888).
// Both paths here do that removeAttribute plus the element's load().
//
// Event names, error types, and error details are the real enums. hls.js
// exposes them as static getters (dist/hls.mjs 35725-35736). The string values
// are in dist/hls.d.ts 1098-1234: ErrorDetails from 1098, ErrorTypes from 1151,
// Events from 1159. vi.importActual loads those objects.
//
// emit does not decide fatal. hls.js registers ErrorController.onErrorOut from
// the constructor (dist/hls.mjs 35865) before any listener WatchPage adds, so
// the data a test passes in is already the data that listener would see.
//
// Used by web/src/pages/WatchPage.playback.test.tsx.

import { vi } from "vitest";

const real = await vi.importActual<typeof import("hls.js")>("hls.js");
const RealHls = real.default;

type Handler = (event: string, data: unknown) => void;

/**
 * Config object stored from the constructor argument. The fields are the ones
 * WatchPage passes when it builds an instance.
 */
export type FakeHlsConfig = {
  enableWorker?: boolean;
  autoStartLoad?: boolean;
  manifestLoadPolicy?: {
    default: {
      maxTimeToFirstByteMs: number;
      maxLoadTimeMs: number;
      timeoutRetry: {
        maxNumRetry: number;
        retryDelayMs: number;
        maxRetryDelayMs: number;
      };
      errorRetry: {
        maxNumRetry: number;
        retryDelayMs: number;
        maxRetryDelayMs: number;
      };
    };
  };
};

const listeners = new WeakMap<FakeHls, Map<string, Handler[]>>();

let hlsSupported = true;

/**
 * Instances constructed since the last resetFakeHls call, in construction order.
 */
export const hlsInstances: FakeHls[] = [];

/**
 * Turns Hls.isSupported on or off for the next WatchPage render.
 * The default is true.
 */
export function setHlsSupported(supported: boolean): void {
  hlsSupported = supported;
}

/**
 * Drops recorded instances and turns isSupported back on.
 * Call this before each test.
 */
export function resetFakeHls(): void {
  hlsInstances.length = 0;
  hlsSupported = true;
}

/**
 * Calls the handlers registered for one event, in registration order.
 *
 * @throws Error when the instance has been destroyed, or was not constructed
 * by this fake.
 */
export function emit(instance: FakeHls, event: string, data: unknown): void {
  if (instance.destroyed) {
    throw new Error("emit() called on a destroyed Hls instance");
  }
  const map = listeners.get(instance);
  if (map === undefined) {
    throw new Error("emit() called on an unknown Hls instance");
  }
  const list = map.get(event);
  if (list === undefined) {
    return;
  }
  for (const handler of [...list]) {
    handler(event, data);
  }
}

/** One startLoad call, in the order WatchPage made it. */
export type FakeStartLoadCall = {
  startPosition?: number;
  skipSeekToStartPosition?: boolean;
};

/**
 * Stand-in for hls.js. Records construction, source, media, startLoad, and
 * destroy. Events, ErrorTypes, and ErrorDetails are the real hls.js enums.
 */
export default class FakeHls {
  /** True unless setHlsSupported has turned it off. */
  static isSupported(): boolean {
    return hlsSupported;
  }

  /** Real hls.js event names, including MANIFEST_PARSED and ERROR. */
  static Events = RealHls.Events;

  /** Real hls.js error type strings, including networkError. */
  static ErrorTypes = RealHls.ErrorTypes;

  /** Real hls.js error detail strings, including manifestLoadTimeOut. */
  static ErrorDetails = RealHls.ErrorDetails;

  /** The object passed to the constructor. */
  readonly config: FakeHlsConfig;

  /** The last URL given to loadSource, or null before that call. */
  url: string | null = null;

  /** The element given to attachMedia, or null before that call. */
  media: HTMLMediaElement | null = null;

  /** True after destroy. A second destroy does not touch the element again. */
  destroyed = false;

  /** startLoad calls in order. Empty until WatchPage starts a held instance. */
  readonly startLoadCalls: FakeStartLoadCall[] = [];

  constructor(config: FakeHlsConfig = {}) {
    this.config = config;
    listeners.set(this, new Map());
    hlsInstances.push(this);
  }

  /**
   * Registers a handler. Handlers for one event run in the order they were added.
   */
  on(event: string, handler: Handler): void {
    const map = listeners.get(this);
    if (map === undefined) {
      throw new Error("on() called on an unknown Hls instance");
    }
    const list = map.get(event);
    if (list === undefined) {
      map.set(event, [handler]);
      return;
    }
    list.push(handler);
  }

  /**
   * Records the manifest URL. Does not fetch it.
   */
  loadSource(url: string): void {
    this.url = url;
  }

  /**
   * Records the element, then resets it through load().
   * hls.js attachMedia (dist/hls.mjs 18701-18715) removes the src and calls
   * load() when appendSource is true, which it sets at 18553 for a
   * ManagedMediaSource (18703-18709). Otherwise it sets media.src to the
   * MediaSource object URL (18713-18715). Setting src also runs the media
   * element load algorithm, so load() here stands for both branches.
   */
  attachMedia(media: HTMLMediaElement): void {
    this.media = media;
    media.removeAttribute("src");
    media.load();
  }

  /**
   * Records a startLoad call.
   *
   * @throws Error when the instance has been destroyed.
   */
  startLoad(startPosition?: number, skipSeekToStartPosition?: boolean): void {
    if (this.destroyed) {
      throw new Error("startLoad() called on a destroyed Hls instance");
    }
    this.startLoadCalls.push({ startPosition, skipSeekToStartPosition });
  }

  /**
   * Marks the instance destroyed and, when a media element was attached,
   * drops its src and calls load() (dist/hls.mjs 18880-18888).
   * A second call does nothing.
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    const media = this.media;
    if (media === null) {
      return;
    }
    media.removeAttribute("src");
    media.load();
  }
}
