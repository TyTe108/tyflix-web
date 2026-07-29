// The signed-in user's own watched-versus-requested numbers: how much they
// asked for, how much they actually watched, and what's sitting there
// untouched. Rendered at /home by App.tsx, inside ProtectedRoute and AppShell.
//
// One call, GET /api/me/stats through api/me.ts. The server joins Plex watch
// history against Seerr's request list and weights the result by file size, so
// everything on this page is GB rather than title counts. Identity comes from
// AuthContext, not from a second fetch.
//
// This is not the landing page despite the name. "/" redirects to /library.

import { useCallback, useEffect, useState } from "react";
import {
  fetchMyStats,
  formatBytes,
  type MyStats,
} from "../api/me";
import { useAuth } from "../auth/AuthContext";

// Drives which of the three mutually exclusive stats states renders below.
type StatsStatus = "loading" | "ready" | "error";

/**
 * Per-user analytics page.
 *
 * Renders nothing at all when there's no user in context. ProtectedRoute
 * should have caught that already, so this is belt and braces.
 */
export function HomePage() {
  const { user, isAdmin } = useAuth();
  const [stats, setStats] = useState<MyStats | null>(null);
  const [statsStatus, setStatsStatus] = useState<StatsStatus>("loading");
  const [statsError, setStatsError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retryStats = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  // Owns the stats load. Fires once on mount, then again whenever Retry bumps
  // reloadKey. There's no polling here; the numbers move slowly.
  useEffect(() => {
    let cancelled = false;
    setStatsStatus("loading");
    setStatsError(null);

    void fetchMyStats()
      .then((data) => {
        if (cancelled) {
          return;
        }
        setStats(data);
        setStatsStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setStats(null);
        setStatsStatus("error");
        setStatsError(
          err instanceof Error ? err.message : "Failed to load stats",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (user === null) {
    return null;
  }

  return (
    <main className="page">
      <h1>Tyflix</h1>

      <p>
        Signed in as <strong>{user.displayName}</strong>
        {isAdmin ? " (admin)" : " (member)"}.
      </p>

      <section className="stats" aria-labelledby="stats-heading">
        <h2 id="stats-heading">Watched vs requested</h2>

        {statsStatus === "loading" ? (
          <p className="muted">Loading your stats…</p>
        ) : null}

        {statsStatus === "error" ? (
          <div className="stats-error">
            <p className="error">{statsError ?? "Failed to load stats"}</p>
            <button type="button" className="btn secondary" onClick={retryStats}>
              Retry
            </button>
          </div>
        ) : null}

        {statsStatus === "ready" && stats !== null ? (
          <StatsBody stats={stats} />
        ) : null}
      </section>
    </main>
  );
}

// The loaded stats: headline watch rate, the three GB totals, request counts,
// and the list of titles you asked for but never finished.
function StatsBody({ stats }: { stats: MyStats }) {
  const { totals, unwatchedTitles, watchedDefinition, plexLinked } = stats;
  // A null rate means nothing has landed yet, so there's no ratio to show.
  // Zero percent would read as a judgement rather than an absence.
  const rateLabel =
    totals.rate === null ? "No downloads yet" : `${totals.rate}% watched`;
  // Clamped because the bar is a raw percentage width and a rate outside 0-100
  // would paint past the track.
  const barWidth = totals.rate === null ? 0 : Math.min(100, Math.max(0, totals.rate));

  return (
    <>
      <p className="stats-rate">{rateLabel}</p>

      <div
        className="stats-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={totals.rate ?? 0}
        aria-label="Watch rate"
      >
        <div className="stats-bar-fill" style={{ width: `${barWidth}%` }} />
      </div>

      <dl className="stats-totals">
        <div>
          <dt>Requested</dt>
          <dd>{formatBytes(totals.gbRequestedBytes)}</dd>
        </div>
        <div>
          <dt>Watched</dt>
          <dd>{formatBytes(totals.gbWatchedBytes)}</dd>
        </div>
        <div>
          <dt>Unwatched</dt>
          <dd>{formatBytes(totals.gbUnwatchedBytes)}</dd>
        </div>
      </dl>

      <p className="stats-counts muted">
        {totals.requests} requests · {totals.available} available ·{" "}
        {totals.pending} pending
      </p>

      {/* The waste list, biggest unwatched footprint first (the server sorts
          it). Shows get the "3/9 eps" counter because partial credit is real
          for them; a movie is all or nothing so the counter is hidden. No
          stable id comes back on these rows, hence the composite key. */}
      <h3 className="stats-unwatched-heading">Unwatched</h3>
      {unwatchedTitles.length === 0 ? (
        <p className="muted">Nothing unwatched — nice.</p>
      ) : (
        <ul className="stats-unwatched-list">
          {unwatchedTitles.map((item) => (
            <li key={`${item.type}:${item.title}:${item.requestedAt}`}>
              <div className="stats-unwatched-row">
                <span className="stats-unwatched-title">{item.title}</span>
                <span className="stats-tag">{item.type === "tv" ? "TV" : "Movie"}</span>
              </div>
              <div className="stats-unwatched-meta muted">
                <span>{formatBytes(item.unwatchedBytes)}</span>
                {item.type === "tv" ? (
                  <span>
                    {item.epsWatched}/{item.epsTotal} eps
                  </span>
                ) : null}
                <span>Requested {item.requestedAt}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* The server sends its own wording for what "watched" means, so the
          definition can change without a frontend deploy. plexLinked false
          means it couldn't match this session to a Plex account, which makes
          the watch sets empty and every number above read as zero watched.
          The response is still a 200, so the caveat has to be said out loud. */}
      <p className="stats-caption muted">{watchedDefinition}</p>
      {!plexLinked ? (
        <p className="stats-caption muted">
          Plex watch history couldn’t be matched for this account.
        </p>
      ) : null}
    </>
  );
}
