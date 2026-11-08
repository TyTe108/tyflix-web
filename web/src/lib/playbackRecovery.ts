// Decisions behind Phase 56.2: restarting a stream that was working when
// hls.js reports a fatal error.
//
// Evidence for the numbers below. Plex ends an idle transcode about 181 s after
// the last request. A player that is paused with a full buffer stops requesting
// by itself (spec E4), and a computer that sleeps stops requesting too, so
// either can stay quiet for that long. hls.js retries a failing fragment 6
// times over about 31 s and then reports a fatal error. By then the transcode
// session is gone, so the URLs of the descriptor are dead and only a fresh
// descriptor (a new session) can play. A restart that starts the new session
// costs one attempt, and a start that Plex answers with a 400 is counted the
// same way (spec E15).
//
// This module holds the pure part: which of three actions a fatal error leads
// to, the budget that decides when a restart may start and when to stop, and
// whether a non-fatal fragment failure means the session has gone stale.
// WatchPage owns the timers, the descriptor fetch and the hls.js instances.

/** Wait before a restart by consecutive failed attempts. The last value repeats. */
export const RECOVERY_DELAYS_MS: readonly number[] = [0, 3_000, 10_000, 30_000];

/** Restarts allowed inside one RECOVERY_WINDOW_MS. A fifth one gives up. */
export const RECOVERY_MAX_RESTARTS = 4;

/** The span in which RECOVERY_MAX_RESTARTS applies, five minutes. */
export const RECOVERY_WINDOW_MS = 300_000;

/** The least time between the starts of two restarts. */
export const RECOVERY_MIN_SPACING_MS = 2_000;

/**
 * Silence after which a failed segment means the session is dead, two minutes.
 * Plex kills an idle transcode about 181 s after its last request, measured
 * 2026-11-06, and 120 s leaves margin under that. The gap is wall time, from
 * Date.now(), because Plex's idle timer runs on wall time and performance.now()
 * may not move while a machine sleeps.
 */
export const STALE_SESSION_MS = 120_000;

/** The hls.js error fields isStaleSessionError reads. */
export type StaleSessionError = {
  fatal: boolean;
  details: string;
};

/**
 * Whether a non-fatal fragment failure arrived after a dead session's silence.
 * True only for details "fragLoadError" or "fragLoadTimeOut", when
 * lastSignOfLifeMs is not null and nowMs is more than STALE_SESSION_MS past it.
 * A fatal error is never stale, because the fatal path decides that one.
 * Throws when nowMs is not a finite number.
 */
export function isStaleSessionError(
  error: StaleSessionError,
  lastSignOfLifeMs: number | null,
  nowMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) {
    throw new Error(`nowMs must be a finite time, got ${nowMs}`);
  }
  if (error.fatal) {
    return false;
  }
  if (
    error.details !== "fragLoadError" &&
    error.details !== "fragLoadTimeOut"
  ) {
    return false;
  }
  if (lastSignOfLifeMs === null) {
    return false;
  }
  return nowMs - lastSignOfLifeMs > STALE_SESSION_MS;
}

/**
 * What a fatal hls.js error leads to.
 * - "fail-over": attach the remote URL of the same descriptor.
 * - "recover": restart the stream with a fresh descriptor.
 * - "fail": show the error state.
 */
export type FatalErrorAction = "fail-over" | "recover" | "fail";

/** The facts the page knows when a fatal error arrives. */
export type FatalErrorContext = {
  /** The attach that raised the error buffered at least one fragment. */
  attachBuffered: boolean;
  /** The descriptor still has a remote URL that this item has not tried. */
  failoverAvailable: boolean;
  /** This item buffered a fragment at some point, so its stream was working. */
  streamEstablished: boolean;
};

/**
 * Decides the action for a fatal error. An attach that buffered nothing and has
 * a remote URL left fails over first, because the local URL may simply be
 * unreachable from this network. After that, an item whose stream was working
 * recovers with a fresh descriptor. An item that never worked fails, which is
 * the error state with the connection report.
 */
export function classifyFatalError(context: FatalErrorContext): FatalErrorAction {
  if (context.failoverAvailable && !context.attachBuffered) {
    return "fail-over";
  }
  return context.streamEstablished ? "recover" : "fail";
}

/**
 * The record of restarts. Values are immutable, and every function that
 * changes it returns a new one.
 * - starts: the times (ms) at which restarts started, newest last.
 * - failedStreak: restart attempts that failed since the stream last played.
 */
export type RecoveryBudget = {
  readonly starts: readonly number[];
  readonly failedStreak: number;
};

/**
 * The plan for the next restart.
 * - restart: wait delayMs, so the start falls at startAtMs.
 * - give-up: restartsInWindow restarts already started inside the window.
 */
export type RestartPlan =
  | { kind: "restart"; delayMs: number; startAtMs: number }
  | { kind: "give-up"; restartsInWindow: number };

/** A budget with no restarts and no failed attempt. */
export function createRecoveryBudget(): RecoveryBudget {
  return { starts: [], failedStreak: 0 };
}

function requireClockValue(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite time of 0 or more, got ${value}`);
  }
}

/**
 * Plans the next restart for a fatal error that arrived at nowMs. The delay
 * follows the failed streak. It grows to the spacing from the previous start if
 * that is longer. The restart counts toward the limit where it will start, so a
 * long wait can move the oldest start out of the window. When the window
 * already holds RECOVERY_MAX_RESTARTS starts, the plan is to give up.
 * Throws when nowMs is NaN, infinite or negative.
 */
export function planRestart(budget: RecoveryBudget, nowMs: number): RestartPlan {
  requireClockValue(nowMs, "nowMs");
  const streakIndex = Math.min(budget.failedStreak, RECOVERY_DELAYS_MS.length - 1);
  const backoffMs = RECOVERY_DELAYS_MS[streakIndex] ?? 0;
  const lastStart = budget.starts.at(-1);
  const spacedAtMs =
    lastStart === undefined ? 0 : lastStart + RECOVERY_MIN_SPACING_MS;
  const startAtMs = Math.max(nowMs + backoffMs, spacedAtMs);
  const restartsInWindow = budget.starts.filter(
    (start) => start > startAtMs - RECOVERY_WINDOW_MS,
  ).length;
  if (restartsInWindow >= RECOVERY_MAX_RESTARTS) {
    return { kind: "give-up", restartsInWindow };
  }
  return { kind: "restart", delayMs: startAtMs - nowMs, startAtMs };
}

/**
 * Records that a restart started at startedAtMs and forgets the starts that
 * have left the window. Throws when startedAtMs is NaN, infinite or negative.
 */
export function recordRestartStart(
  budget: RecoveryBudget,
  startedAtMs: number,
): RecoveryBudget {
  requireClockValue(startedAtMs, "startedAtMs");
  const kept = budget.starts.filter(
    (start) => start > startedAtMs - RECOVERY_WINDOW_MS,
  );
  return { starts: [...kept, startedAtMs], failedStreak: budget.failedStreak };
}

/** Records that the restart attempt in flight failed, which lengthens the next delay. */
export function recordAttemptFailed(budget: RecoveryBudget): RecoveryBudget {
  return { starts: budget.starts, failedStreak: budget.failedStreak + 1 };
}

/**
 * Records that a restarted stream buffered a fragment. The delay starts over,
 * and the window keeps its starts, so a stream that dies again and again still
 * reaches the limit.
 */
export function recordAttemptRecovered(budget: RecoveryBudget): RecoveryBudget {
  return { starts: budget.starts, failedStreak: 0 };
}
