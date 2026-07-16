import { useCallback, useEffect, useState } from "react";
import {
  fetchWatchlist,
  type WatchlistItem,
} from "../api/watchlist";
import { MediaCard } from "../components/MediaCard";

type LoadStatus = "loading" | "ready" | "error";

export function WatchlistPage() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchWatchlist()
      .then((results) => {
        if (cancelled) {
          return;
        }
        setItems(results);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setItems([]);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load watchlist",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <main className="page page-wide">
      <h1>Watchlist</h1>

      <section aria-labelledby="watchlist-heading">
        <h2 id="watchlist-heading" className="visually-hidden">
          Watchlist items
        </h2>

        {status === "loading" ? (
          <p className="muted">Loading your watchlist…</p>
        ) : null}

        {status === "error" ? (
          <div className="stats-error">
            <p className="error">{error ?? "Failed to load watchlist"}</p>
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}

        {status === "ready" && items.length === 0 ? (
          <p className="muted">Your Plex Watchlist is empty.</p>
        ) : null}

        {status === "ready" && items.length > 0 ? (
          <ul className="media-grid">
            {items.map((item) => (
              <li key={`${item.mediaType}:${item.tmdbId}`}>
                <MediaCard
                  item={{ ...item, year: null }}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
