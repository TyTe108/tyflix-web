import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchTrending,
  searchMedia,
  type MediaSummary,
} from "../api/discover";
import { useAuth } from "../auth/AuthContext";

type LoadStatus = "loading" | "ready" | "error";

const SEARCH_DEBOUNCE_MS = 400;

export function DiscoverPage() {
  const { isAdmin, logout } = useAuth();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<MediaSummary[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    const load =
      debouncedQuery === ""
        ? fetchTrending().then((items) => items)
        : searchMedia(debouncedQuery).then((body) => body.results);

    void load
      .then((items) => {
        if (cancelled) {
          return;
        }
        setResults(items);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setResults([]);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load discover results",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, reloadKey]);

  const heading =
    debouncedQuery === "" ? "Trending this week" : `Results for “${debouncedQuery}”`;

  return (
    <main className="page page-wide">
      <header className="row">
        <h1>Discover</h1>
        <div className="nav-links">
          <Link to="/">Home</Link>
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

      <label className="discover-search">
        <span className="visually-hidden">Search movies and TV</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search movies and TV…"
          autoComplete="off"
        />
      </label>

      <section className="discover-results" aria-labelledby="discover-heading">
        <h2 id="discover-heading">{heading}</h2>

        {status === "loading" ? (
          <p className="muted">Loading…</p>
        ) : null}

        {status === "error" ? (
          <div className="stats-error">
            <p className="error">{error ?? "Failed to load results"}</p>
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}

        {status === "ready" && results.length === 0 ? (
          <p className="muted">No results.</p>
        ) : null}

        {status === "ready" && results.length > 0 ? (
          <ul className="media-grid">
            {results.map((item) => (
              <li key={`${item.mediaType}:${item.tmdbId}`}>
                <MediaCard item={item} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}

function MediaCard({ item }: { item: MediaSummary }) {
  const to = `/media/${item.mediaType}/${item.tmdbId}`;
  const yearLabel = item.year !== null ? String(item.year) : "—";

  return (
    <Link to={to} className="media-card">
      <div className="media-poster">
        {item.posterUrl ? (
          <img src={item.posterUrl} alt="" loading="lazy" />
        ) : (
          <div className="media-poster-placeholder" aria-hidden="true">
            No poster
          </div>
        )}
      </div>
      <div className="media-card-body">
        <div className="media-card-title-row">
          <span className="media-card-title">{item.title}</span>
          <span className="stats-tag">
            {item.mediaType === "tv" ? "TV" : "Movie"}
          </span>
        </div>
        <p className="media-card-year muted">{yearLabel}</p>
      </div>
    </Link>
  );
}
