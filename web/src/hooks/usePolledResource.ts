// Fetch something now, then keep re-fetching it on a timer. Every live panel on
// the admin dashboard runs on this hook, and nothing else in the app uses it.
//
// The behavior worth knowing before you point another panel at it:
//
//   - Once there's data, a failed poll does not blow the panel away. The stale
//     data stays on screen, status stays "ready", and `error` fills in so the
//     UI can show a banner beside numbers it knows are old. "error" status is
//     reserved for failing before anything ever loaded.
//   - One request in flight at a time. A tick that fires while the previous
//     request is still open is dropped, not queued, so a slow endpoint can't
//     pile up a backlog of overlapping calls.
//   - The interval is exactly what the caller passes. No floor, no jitter, no
//     backoff on repeated failure.
//
// That last point has bitten before. AdminPage is tabbed, so only one of its
// seven panels is mounted at a time, but the System and Containers panels poll
// at 5s. One of those left open is 180 requests per 15-minute window on its
// own. The general limiter used to allow 200 per window and it 429'd the admin
// out of their own dashboard. It's 1000 now, see
// server/src/middleware/rateLimit.ts. Anything new at 5s spends a real slice of
// that budget, so check the ceiling before adding one.

import { useCallback, useEffect, useRef, useState } from "react";

type LoadStatus = "loading" | "ready" | "error";

type PolledResource<T> = {
  data: T | null;
  status: LoadStatus;
  error: string | null; // set on failure even while status stays "ready"
  lastUpdated: number | null; // Date.now() of the last success, for "as of" text
  refresh: () => void; // manual poke; a no-op after unmount
};

/**
 * Polls `fetcher` every `intervalMs` and reports the latest result.
 *
 * `fetcher` has to be a stable reference. It's a dependency of the effect that
 * owns the timer, so passing an inline arrow tears down and rebuilds the
 * interval on every render, which quietly resets the clock and can starve the
 * poll entirely. Every caller in AdminPage passes a module-level function from
 * api/admin.ts, which is why this holds.
 *
 * Errors come back through `error` as a string rather than being thrown, since
 * a background poll has nobody to throw to.
 */
export function usePolledResource<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
): PolledResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // Indirection so the returned `refresh` keeps one identity for the life of
  // the component while the function it points at gets rebuilt with each new
  // effect run. Without it, refresh would change every time the effect re-ran
  // and cascade re-renders into anything that depends on it.
  const refreshRef = useRef<() => void>(() => undefined);

  // Owns the whole polling lifecycle: first fetch, the timer, and teardown.
  // Re-runs only when the fetcher or the interval changes, which for every
  // current caller means never after mount.
  //
  // The three locals live in the closure rather than in state on purpose. None
  // of them should trigger a render, and each effect run needs its own copies
  // so an interval from a previous run can't write into the current one.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let currentData: T | null = null;

    const fetchResource = async (showLoading: boolean) => {
      // Drop overlapping ticks. A request slower than the interval would
      // otherwise stack up one call per tick until it finished.
      if (inFlight) {
        return;
      }

      // Only ever show a spinner on a cold panel. A manual refresh with data
      // already on screen updates in place instead of blanking the numbers out
      // and jumping the page.
      if (showLoading && currentData === null) {
        setStatus("loading");
        setError(null);
      }

      inFlight = true;

      try {
        const response = await fetcher();
        if (cancelled) {
          return;
        }

        currentData = response;
        setData(response);
        setStatus("ready");
        setError(null);
        setLastUpdated(Date.now());
      } catch (err: unknown) {
        if (cancelled) {
          return;
        }

        // A failure only downgrades the panel if there was never anything to
        // show. With data in hand it stays "ready" and the error rides
        // alongside, so a single bad poll doesn't wipe a working dashboard.
        setError(
          err instanceof Error ? err.message : "Failed to refresh resource",
        );
        setStatus(currentData === null ? "error" : "ready");
      } finally {
        inFlight = false;
      }
    };

    // Manual refresh is the only caller that asks for the loading state.
    refreshRef.current = () => {
      void fetchResource(true);
    };

    // Fetch immediately, then on the timer. The first call passes false because
    // status already starts at "loading" from useState, so asking again would
    // just be a redundant setState.
    void fetchResource(false);
    const intervalId = window.setInterval(() => {
      void fetchResource(false);
    }, intervalMs);

    // Teardown does three separate jobs: stop the timer, stop any in-flight
    // response from writing into an unmounted component, and neuter the ref so
    // a refresh() held by a parent can't restart polling after cleanup.
    return () => {
      cancelled = true;
      refreshRef.current = () => undefined;
      window.clearInterval(intervalId);
    };
  }, [fetcher, intervalMs]);

  const refresh = useCallback(() => {
    refreshRef.current();
  }, []);

  return { data, status, error, lastUpdated, refresh };
}
