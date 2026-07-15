import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchMyStats,
  formatBytes,
  type MyStats,
} from "../api/me";
import { useAuth } from "../auth/AuthContext";

type StatsStatus = "loading" | "ready" | "error";

export function HomePage() {
  const { user, isAdmin, logout } = useAuth();
  const [stats, setStats] = useState<MyStats | null>(null);
  const [statsStatus, setStatsStatus] = useState<StatsStatus>("loading");
  const [statsError, setStatsError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retryStats = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

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
      <header className="row">
        <h1>Tyflix</h1>
        <div className="nav-links">
          <Link to="/discover">Discover</Link>
          <Link to="/watchlist">Watchlist</Link>
          <Link to="/requests">My Requests</Link>
          {isAdmin ? <Link to="/admin">Admin</Link> : null}
          <button
            type="button"
            className="btn secondary"
            onClick={() => void logout()}
          >
            Logout
          </button>
        </div>
      </header>

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

function StatsBody({ stats }: { stats: MyStats }) {
  const { totals, unwatchedTitles, watchedDefinition, plexLinked } = stats;
  const rateLabel =
    totals.rate === null ? "No downloads yet" : `${totals.rate}% watched`;
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

      <p className="stats-caption muted">{watchedDefinition}</p>
      {!plexLinked ? (
        <p className="stats-caption muted">
          Plex watch history couldn’t be matched for this account.
        </p>
      ) : null}
    </>
  );
}
