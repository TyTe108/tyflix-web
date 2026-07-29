// The signed-in user's Plex Watchlist as a poster grid. Rendered at /watchlist
// by App.tsx, inside ProtectedRoute and AppShell.
//
// One call, GET /api/watchlist through api/watchlist.ts. The server reads the
// list out of Seerr's per-user mirror rather than plex.tv, and stamps each row
// with availability and a TMDB poster before it gets here. Every card links
// through to /media/:type/:tmdbId.

import { useCallback, useEffect, useState } from "react";
import {
  fetchWatchlist,
  type WatchlistItem,
} from "../api/watchlist";
import { MediaCard } from "../components/MediaCard";

// Drives which of the four mutually exclusive body states renders below.
type LoadStatus = "loading" | "ready" | "error";

/**
 * Poster grid of everything on the user's Plex Watchlist.
 *
 * Read-only. Adding and removing happens in Plex, not here.
 */
export function WatchlistPage() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Bumping reloadKey is the only way to re-run the fetch, since there's
  // nothing else in its dependency list.
  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  // Owns the whole watchlist load. Runs on mount and again on every retry.
  // The cancelled flag stops a slow response from writing state after the
  // component is gone.
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

        {/* Poster grid. A tmdbId can repeat across a movie and a show, so the
            key pairs it with mediaType. WatchlistItem carries no release year,
            hence the explicit null MediaCard renders as a dash. */}
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
