// Fake HTMLMediaElement playback surface for WatchPage tests.
//
// Installed on HTMLMediaElement.prototype for one test and restored after.
// jsdom defines currentTime, paused, readyState, and duration as configurable
// accessors on that prototype, so each test can replace them and put the
// originals back.
//
// load() follows the HTML media element rules the phase 56 spec relies on:
// position 0, readyState HAVE_NOTHING, paused true, an emptied event, and a
// timeupdate when the position changed. It does not fire pause. hls.js
// destroy reaches that load() from dist/hls.mjs 18880-18888.
//
// This fake fires every event synchronously, inside the call. In a browser,
// load() queues emptied and timeupdate as tasks that run after the current
// script, and skips the whole reset, emptied included, when networkState is
// NETWORK_EMPTY (an element that never loaded). A test here sees emptied
// before the rest of the calling code runs, which a browser wouldn't do.
//
// Setting currentTime while readyState is HAVE_NOTHING stores the value and
// fires nothing. Otherwise the setter fires seeking and seeked. play() sets
// paused false, fires play, and resolves. It does not fire playing. pause()
// fires pause only when the element was playing.
//
// The helpers that set readyState and currentTime write the stored values and
// do not fire seeking. fireMediaEvent is how a test dispatches playing,
// timeupdate, or ended. Nothing in this file fires playing or timeupdate on
// its own, except load()'s timeupdate when the position changed, so a test
// decides when media time moves.
//
// Used by web/src/pages/WatchPage.playback.test.tsx.

type MediaState = {
  currentTime: number;
  paused: boolean;
  readyState: number;
  duration: number;
  play: number;
  pause: number;
  load: number;
};

type SavedProperty = {
  key: string;
  descriptor: PropertyDescriptor;
};

const MEDIA_KEYS = [
  "currentTime",
  "paused",
  "readyState",
  "duration",
  "play",
  "pause",
  "load",
] as const;

let states = new WeakMap<HTMLMediaElement, MediaState>();
let saved: SavedProperty[] = [];
let installed = false;

function elementState(element: HTMLMediaElement): MediaState {
  let state = states.get(element);
  if (state === undefined) {
    state = {
      currentTime: 0,
      paused: true,
      readyState: HTMLMediaElement.HAVE_NOTHING,
      duration: Number.NaN,
      play: 0,
      pause: 0,
      load: 0,
    };
    states.set(element, state);
  }
  return state;
}

function requireDescriptor(key: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    key,
  );
  if (descriptor === undefined) {
    throw new Error(`HTMLMediaElement.prototype.${key} is missing`);
  }
  return descriptor;
}

function load(this: HTMLMediaElement): void {
  const state = elementState(this);
  const previousTime = state.currentTime;
  state.currentTime = 0;
  state.readyState = HTMLMediaElement.HAVE_NOTHING;
  state.paused = true;
  state.load += 1;
  // Fires no pause event. The timeline bug in spec E5 depends on that:
  // hls.js teardown calls load(), the position becomes 0, and a heartbeat
  // that only stops on pause keeps reporting that 0.
  this.dispatchEvent(new Event("emptied"));
  if (previousTime !== 0) {
    this.dispatchEvent(new Event("timeupdate"));
  }
}

function play(this: HTMLMediaElement): Promise<void> {
  const state = elementState(this);
  state.paused = false;
  state.play += 1;
  this.dispatchEvent(new Event("play"));
  return Promise.resolve();
}

function pause(this: HTMLMediaElement): void {
  const state = elementState(this);
  state.pause += 1;
  if (state.paused) {
    return;
  }
  state.paused = true;
  this.dispatchEvent(new Event("pause"));
}

function installAccessors(): void {
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    enumerable: true,
    get() {
      return elementState(this as HTMLMediaElement).currentTime;
    },
    set(value: number) {
      const element = this as HTMLMediaElement;
      const state = elementState(element);
      const next = Number(value);
      if (state.readyState === HTMLMediaElement.HAVE_NOTHING) {
        state.currentTime = next;
        return;
      }
      element.dispatchEvent(new Event("seeking"));
      state.currentTime = next;
      element.dispatchEvent(new Event("seeked"));
    },
  });

  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    enumerable: true,
    get() {
      return elementState(this as HTMLMediaElement).paused;
    },
  });

  Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
    configurable: true,
    enumerable: true,
    get() {
      return elementState(this as HTMLMediaElement).readyState;
    },
  });

  Object.defineProperty(HTMLMediaElement.prototype, "duration", {
    configurable: true,
    enumerable: true,
    get() {
      return elementState(this as HTMLMediaElement).duration;
    },
  });

  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: play,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: pause,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: load,
  });
}

/**
 * Replaces media accessors and play/pause/load on HTMLMediaElement.prototype.
 *
 * @throws Error when the fake is already installed, or a property is missing.
 */
export function installFakeMedia(): void {
  if (installed) {
    throw new Error("fake media is already installed");
  }
  saved = MEDIA_KEYS.map((key) => ({
    key,
    descriptor: requireDescriptor(key),
  }));
  installAccessors();
  installed = true;
}

/**
 * Puts the jsdom media accessors and methods back.
 *
 * @throws Error when the fake is not installed.
 */
export function restoreFakeMedia(): void {
  if (!installed) {
    throw new Error("fake media is not installed");
  }
  for (const item of saved) {
    Object.defineProperty(HTMLMediaElement.prototype, item.key, item.descriptor);
  }
  saved = [];
  states = new WeakMap();
  installed = false;
}

/**
 * Stores readyState without firing a media event.
 */
export function setMediaReadyState(
  video: HTMLMediaElement,
  readyState: number,
): void {
  elementState(video).readyState = readyState;
}

/**
 * Stores currentTime without firing seeking, seeked, or timeupdate.
 * Use this to place the playhead, then fireMediaEvent for the event the test
 * wants the page to see.
 */
export function setMediaCurrentTime(
  video: HTMLMediaElement,
  seconds: number,
): void {
  elementState(video).currentTime = seconds;
}

/**
 * Dispatches playing, timeupdate, or ended. Does not change currentTime,
 * paused, or readyState.
 */
export function fireMediaEvent(
  video: HTMLMediaElement,
  type: "playing" | "timeupdate" | "ended",
): void {
  video.dispatchEvent(new Event(type));
}

/**
 * How many times play, pause, and load ran on this element.
 * pause counts calls that fired no event because the element was already paused.
 */
export function mediaCalls(video: HTMLMediaElement): {
  play: number;
  pause: number;
  load: number;
} {
  const state = elementState(video);
  return { play: state.play, pause: state.pause, load: state.load };
}
