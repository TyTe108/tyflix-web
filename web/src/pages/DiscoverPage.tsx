import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  browseMedia,
  fetchGenres,
  fetchTrending,
  searchMedia,
  type Genre,
  type MediaSummary,
  type MediaType,
} from "../api/discover";
import { useAuth } from "../auth/AuthContext";
import { MediaCard } from "../components/MediaCard";

type LoadStatus = "loading" | "ready" | "error";
type BrowseMediaType = "all" | MediaType;

const SEARCH_DEBOUNCE_MS = 400;

export function DiscoverPage() {
  const { isAdmin, logout } = useAuth();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<MediaSummary[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mediaType, setMediaType] = useState<BrowseMediaType>("all");
  const [genres, setGenres] = useState<Genre[]>([]);
  const [selectedGenreId, setSelectedGenreId] = useState<number | null>(null);
  const [genresLoading, setGenresLoading] = useState(false);

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
    if (mediaType === "all") {
      setGenres([]);
      setGenresLoading(false);
      return;
    }

    let cancelled = false;
    setGenres([]);
    setGenresLoading(true);

    void fetchGenres(mediaType)
      .then((items) => {
        if (!cancelled) {
          setGenres(items);
          setGenresLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGenres([]);
          setGenresLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mediaType]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    const load =
      debouncedQuery !== ""
        ? searchMedia(debouncedQuery).then((body) => body.results)
        : mediaType === "all"
          ? fetchTrending()
          : browseMedia(
              mediaType,
              selectedGenreId ?? undefined,
            ).then((body) => body.results);

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
  }, [debouncedQuery, mediaType, selectedGenreId, reloadKey]);

  const selectedGenre = genres.find(
    (genre) => genre.id === selectedGenreId,
  );
  const heading =
    debouncedQuery !== ""
      ? `Results for “${debouncedQuery}”`
      : mediaType === "all"
        ? "Trending this week"
        : `Popular ${selectedGenre ? `${selectedGenre.name} ` : ""}${
            mediaType === "movie" ? "Movies" : "TV"
          }`;
  const showFilters = query.trim() === "" && debouncedQuery === "";

  function selectMediaType(nextMediaType: BrowseMediaType) {
    setMediaType(nextMediaType);
    setSelectedGenreId(null);
  }

  return (
    <main className="page page-wide">
      <header className="row">
        <h1>Discover</h1>
        <div className="nav-links">
          <Link to="/">Home</Link>
          <Link to="/watchlist">Watchlist</Link>
          <Link to="/issues">My Issues</Link>
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

      {showFilters ? (
        <div className="discover-filters" aria-label="Browse filters">
          <div className="discover-media-toggle" aria-label="Media type">
            {(
              [
                ["all", "All"],
                ["movie", "Movies"],
                ["tv", "TV"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={
                  mediaType === value
                    ? "discover-filter-button active"
                    : "discover-filter-button"
                }
                aria-pressed={mediaType === value}
                onClick={() => selectMediaType(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {mediaType !== "all" ? (
            <label className="discover-genre-filter">
              <span>Genre</span>
              <select
                value={selectedGenreId ?? ""}
                disabled={genresLoading}
                onChange={(event) =>
                  setSelectedGenreId(
                    event.target.value === ""
                      ? null
                      : Number(event.target.value),
                  )
                }
              >
                <option value="">
                  {genresLoading ? "Loading genres…" : "All genres"}
                </option>
                {genres.map((genre) => (
                  <option key={genre.id} value={genre.id}>
                    {genre.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

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
