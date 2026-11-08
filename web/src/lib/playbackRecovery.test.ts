// classifyFatalError and the restart budget behind Phase 56.2. These are the
// numbers the page relies on, so the tables here pin each one: the three
// outcomes for a fatal hls.js error, the delays by consecutive failed attempt,
// the limit of 4 restarts in 5 minutes, the 2 s spacing, what a recovery
// resets, and that a bad clock value throws instead of planning a restart.
import { describe, expect, it } from "vitest";
import {
  RECOVERY_DELAYS_MS,
  RECOVERY_MAX_RESTARTS,
  RECOVERY_MIN_SPACING_MS,
  RECOVERY_WINDOW_MS,
  classifyFatalError,
  createRecoveryBudget,
  planRestart,
  recordAttemptFailed,
  recordAttemptRecovered,
  recordRestartStart,
  type RecoveryBudget,
  type RestartPlan,
} from "./playbackRecovery";

function expectRestart(plan: RestartPlan): { delayMs: number; startAtMs: number } {
  if (plan.kind !== "restart") {
    throw new Error(`expected a restart, got ${JSON.stringify(plan)}`);
  }
  return { delayMs: plan.delayMs, startAtMs: plan.startAtMs };
}

// A budget that has started restarts at these times, with no failed attempt.
function budgetWithStarts(starts: number[]): RecoveryBudget {
  let budget = createRecoveryBudget();
  for (const start of starts) {
    budget = recordRestartStart(budget, start);
  }
  return budget;
}

describe("the budget numbers", () => {
  it("are the confirmed D10 values", () => {
    expect(RECOVERY_DELAYS_MS).toEqual([0, 3_000, 10_000, 30_000]);
    expect(RECOVERY_MAX_RESTARTS).toBe(4);
    expect(RECOVERY_WINDOW_MS).toBe(300_000);
    expect(RECOVERY_MIN_SPACING_MS).toBe(2_000);
  });
});

describe("classifyFatalError", () => {
  it("fails over when this attach buffered nothing and the failover is still open", () => {
    expect(
      classifyFatalError({
        attachBuffered: false,
        failoverAvailable: true,
        streamEstablished: false,
      }),
    ).toBe("fail-over");
  });

  it("still fails over first inside a restart attempt on an established item", () => {
    expect(
      classifyFatalError({
        attachBuffered: false,
        failoverAvailable: true,
        streamEstablished: true,
      }),
    ).toBe("fail-over");
  });

  it("recovers when the failover is spent and the item's stream was established", () => {
    expect(
      classifyFatalError({
        attachBuffered: false,
        failoverAvailable: false,
        streamEstablished: true,
      }),
    ).toBe("recover");
  });

  it("recovers a buffered attach even though the failover is still open", () => {
    expect(
      classifyFatalError({
        attachBuffered: true,
        failoverAvailable: true,
        streamEstablished: true,
      }),
    ).toBe("recover");
  });

  it("fails, which is the error state, before anything was established", () => {
    expect(
      classifyFatalError({
        attachBuffered: false,
        failoverAvailable: false,
        streamEstablished: false,
      }),
    ).toBe("fail");
  });
});

describe("planRestart", () => {
  it("plans the first restart at once", () => {
    const plan = expectRestart(planRestart(createRecoveryBudget(), 1_000));

    expect(plan).toEqual({ delayMs: 0, startAtMs: 1_000 });
  });

  it("waits 0, 3, 10 and 30 s by consecutive failed attempt, then gives up on the fifth", () => {
    let budget = createRecoveryBudget();
    let now = 1_000;
    const delays: number[] = [];

    for (let restart = 0; restart < RECOVERY_MAX_RESTARTS; restart += 1) {
      const plan = expectRestart(planRestart(budget, now));
      delays.push(plan.delayMs);
      budget = recordRestartStart(budget, plan.startAtMs);
      // The attempt runs for half a second, then fails.
      now = plan.startAtMs + 500;
      budget = recordAttemptFailed(budget);
    }

    expect(delays).toEqual([0, 3_000, 10_000, 30_000]);
    expect(planRestart(budget, now)).toEqual({
      kind: "give-up",
      restartsInWindow: 4,
    });
  });

  it("repeats the last delay for every failed attempt beyond the table", () => {
    let budget = createRecoveryBudget();
    for (let failure = 0; failure < 7; failure += 1) {
      budget = recordAttemptFailed(budget);
    }

    expect(expectRestart(planRestart(budget, 5_000)).delayMs).toBe(30_000);
  });

  it("gives up on a fifth start inside any 5 minutes and allows it again once the oldest start leaves", () => {
    const budget = budgetWithStarts([0, 10_000, 20_000, 30_000]);

    expect(planRestart(budget, RECOVERY_WINDOW_MS - 1)).toEqual({
      kind: "give-up",
      restartsInWindow: 4,
    });
    expect(planRestart(budget, RECOVERY_WINDOW_MS)).toEqual({
      kind: "restart",
      delayMs: 0,
      startAtMs: RECOVERY_WINDOW_MS,
    });
  });

  it("counts a planned start by where it will fall, so a long delay can leave the window", () => {
    // Failed three times, so the next delay is 30 s. At 280 s the oldest start
    // (0 s) is still in the window, but the restart will start at 310 s.
    let budget = budgetWithStarts([0, 100_000, 200_000, 250_000]);
    for (let failure = 0; failure < 3; failure += 1) {
      budget = recordAttemptFailed(budget);
    }

    expect(planRestart(budget, 280_000)).toEqual({
      kind: "restart",
      delayMs: 30_000,
      startAtMs: 310_000,
    });
  });

  it("keeps two starts at least 2 s apart", () => {
    const budget = budgetWithStarts([10_000]);

    expect(expectRestart(planRestart(budget, 10_500))).toEqual({
      delayMs: 1_500,
      startAtMs: 12_000,
    });
    expect(expectRestart(planRestart(budget, 12_000))).toEqual({
      delayMs: 0,
      startAtMs: 12_000,
    });
  });

  it("lets a longer backoff delay win over the spacing", () => {
    let budget = budgetWithStarts([10_000]);
    budget = recordAttemptFailed(budget);

    expect(expectRestart(planRestart(budget, 10_500)).delayMs).toBe(3_000);
  });

  it("throws on a NaN, infinite or negative time", () => {
    const budget = createRecoveryBudget();

    expect(() => planRestart(budget, Number.NaN)).toThrow();
    expect(() => planRestart(budget, -1)).toThrow();
    expect(() => planRestart(budget, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("recording attempts", () => {
  it("recovery resets the delay index and leaves the window count alone", () => {
    let budget = budgetWithStarts([0, 10_000, 20_000]);
    for (let failure = 0; failure < 3; failure += 1) {
      budget = recordAttemptFailed(budget);
    }
    expect(budget.failedStreak).toBe(3);

    budget = recordAttemptRecovered(budget);

    expect(budget.failedStreak).toBe(0);
    expect(budget.starts).toEqual([0, 10_000, 20_000]);
    // The next restart is immediate again, and it is the fourth in the window.
    expect(expectRestart(planRestart(budget, 60_000)).delayMs).toBe(0);
    budget = recordRestartStart(budget, 60_000);
    expect(planRestart(budget, 70_000)).toEqual({
      kind: "give-up",
      restartsInWindow: 4,
    });
  });

  it("returns a new budget and leaves the old one unchanged", () => {
    const first = createRecoveryBudget();
    const started = recordRestartStart(first, 5_000);
    const failed = recordAttemptFailed(started);

    expect(first).toEqual({ starts: [], failedStreak: 0 });
    expect(started).toEqual({ starts: [5_000], failedStreak: 0 });
    expect(failed).toEqual({ starts: [5_000], failedStreak: 1 });
  });

  it("drops starts that have left the window when a new start is recorded", () => {
    let budget = budgetWithStarts([0, 100_000]);
    budget = recordRestartStart(budget, 350_000);

    expect(budget.starts).toEqual([100_000, 350_000]);
  });

  it("throws when a start is recorded at a NaN, infinite or negative time", () => {
    const budget = createRecoveryBudget();

    expect(() => recordRestartStart(budget, Number.NaN)).toThrow();
    expect(() => recordRestartStart(budget, -5)).toThrow();
    expect(() => recordRestartStart(budget, Number.POSITIVE_INFINITY)).toThrow();
  });
});
