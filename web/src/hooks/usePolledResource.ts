import { useCallback, useEffect, useRef, useState } from "react";

type LoadStatus = "loading" | "ready" | "error";

type PolledResource<T> = {
  data: T | null;
  status: LoadStatus;
  error: string | null;
  lastUpdated: number | null;
  refresh: () => void;
};

export function usePolledResource<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
): PolledResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let currentData: T | null = null;

    const fetchResource = async (showLoading: boolean) => {
      if (inFlight) {
        return;
      }

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

        setError(
          err instanceof Error ? err.message : "Failed to refresh resource",
        );
        setStatus(currentData === null ? "error" : "ready");
      } finally {
        inFlight = false;
      }
    };

    refreshRef.current = () => {
      void fetchResource(true);
    };

    void fetchResource(false);
    const intervalId = window.setInterval(() => {
      void fetchResource(false);
    }, intervalMs);

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
