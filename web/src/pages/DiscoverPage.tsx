// Global browse: TMDB trending, popular and upcoming, with live Plex
// availability layered on each poster. Green means it's already on the server,
// amber means partial. Rendered at /discover by App.tsx, inside ProtectedRoute
// and AppShell.
//
// Six endpoints, all under /api/discover through api/discover.ts: /trending,
// /upcoming, /browse, /search and /genres, plus /studios once at mount. The
// server calls TMDB, then annotates every row with Seerr's media status, which
// is the TMDB-id-to-Plex join that makes those status corners accurate instead
// of a guess by title.
//
// This browses the whole of TMDB, not the server. LibraryPage is the one that
// browses what's actually on Plex.

import { useCallback, useEffect, useState } from "react";
import {
  browseMedia,
  fetchGenres,
  fetchStudios,
  fetchTrending,
  fetchUpcoming,
  searchMedia,
  type Genre,
  type MediaSummary,
  type MediaType,
  type StudioOption,
} from "../api/discover";
import { Dropdown } from "../components/Dropdown";
import { MediaCard } from "../components/MediaCard";

// Drives which of the four mutually exclusive result states renders below.
type LoadStatus = "loading" | "ready" | "error";
// "all" is a UI-only value. The API's MediaType is strictly movie or tv, so
// "all" maps to the trending feed rather than a browse call.
type BrowseMediaType = "all" | MediaType;
type BrowseMode = "popular" | "upcoming";

const SEARCH_DEBOUNCE_MS = 400;

/**
 * TMDB discovery with Plex availability on top.
 *
 * Search and browse are mutually exclusive. Typing anything hides the filter
 * row and switches the results to a search, and clearing the box puts the
 * filters back exactly as they were.
 */
export function DiscoverPage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<MediaSummary[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mediaType, setMediaType] = useState<BrowseMediaType>("all");
  const [browseMode, setBrowseMode] = useState<BrowseMode>("popular");
  const [genres, setGenres] = useState<Genre[]>([]);
  const [selectedGenreId, setSelectedGenreId] = useState<number | null>(null);
  const [genresLoading, setGenresLoading] = useState(false);
  const [studios, setStudios] = useState<StudioOption[]>([]);
  const [networks, setNetworks] = useState<StudioOption[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);

  // Debounce. The input updates `query` on every keystroke for responsiveness,
  // but only the settled value reaches `debouncedQuery`, and the results
  // effect below watches that one. Each keystroke cancels the pending timer.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  // Studio and network lists, fetched once at mount. Both come back in one
  // response and neither changes, so there's nothing to re-run on. A failure
  // is swallowed to empty lists, which leaves the dropdown with just its
  // "All studios" option instead of breaking the page.
  useEffect(() => {
    let cancelled = false;
    void fetchStudios()
      .then((result) => {
        if (!cancelled) {
          setStudios(result.studios);
          setNetworks(result.networks);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStudios([]);
          setNetworks([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  // Genre list, reloaded whenever the media type changes. TMDB keeps separate
  // genre vocabularies for film and television, so this can't be fetched once
  // and shared. "All" has no genre list at all, hence the early clear.
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

  // The results grid. Every control on the page feeds this one effect, and the
  // chain below picks exactly one endpoint out of four:
  //
  //   a query          -> /search, which ignores every filter
  //   media type "all" -> /trending
  //   upcoming         -> /upcoming for that type
  //   otherwise        -> /browse with whatever genre and studio are set
  //
  // companyId and networkId are the same dropdown pointed at two different
  // TMDB parameters, which is why the spread picks by media type.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    const load =
      debouncedQuery !== ""
        ? searchMedia(debouncedQuery).then((body) => body.results)
        : mediaType === "all"
          ? fetchTrending()
          : browseMode === "upcoming"
            ? fetchUpcoming(mediaType)
            : browseMedia(mediaType, {
                ...(selectedGenreId !== null
                  ? { genreId: selectedGenreId }
                  : {}),
                ...(mediaType === "movie" && selectedSourceId !== null
                  ? { companyId: selectedSourceId }
                  : {}),
                ...(mediaType === "tv" && selectedSourceId !== null
                  ? { networkId: selectedSourceId }
                  : {}),
              }).then((body) => body.results);

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
  }, [
    debouncedQuery,
    mediaType,
    browseMode,
    selectedGenreId,
    selectedSourceId,
    reloadKey,
  ]);

  // One dropdown, two backing lists: studios for film, networks for TV.
  const selectedGenre = genres.find(
    (genre) => genre.id === selectedGenreId,
  );
  const sourceOptions = mediaType === "movie" ? studios : networks;
  const selectedSource = sourceOptions.find(
    (source) => source.id === selectedSourceId,
  );
  const mediaTypeLabel = mediaType === "movie" ? "Movies" : "TV";
  // The heading has to describe whichever branch the effect above took, so it
  // walks the same conditions in the same order. Studio wins over genre when
  // both are set, which is a labelling choice only; the request still sends
  // both filters.
  const heading =
    debouncedQuery !== ""
      ? `Results for “${debouncedQuery}”`
      : mediaType === "all"
        ? "Trending this week"
        : browseMode === "upcoming"
          ? `Upcoming ${mediaTypeLabel}`
          : selectedSource
            ? `Popular ${selectedSource.name} ${mediaTypeLabel}`
            : `Popular ${selectedGenre ? `${selectedGenre.name} ` : ""}${mediaTypeLabel}`;
  // Both the raw and the debounced query have to be empty. Checking only the
  // debounced one would leave the filters visible for 400ms after you start
  // typing, and checking only the raw one would hide them before the search
  // has actually kicked in.
  const showFilters = query.trim() === "" && debouncedQuery === "";

  // Switching media type resets everything downstream of it. Genre and studio
  // ids belong to one TMDB vocabulary, so carrying a movie genre over to TV
  // would send a meaningless filter.
  function selectMediaType(nextMediaType: BrowseMediaType) {
    setMediaType(nextMediaType);
    setBrowseMode("popular");
    setSelectedGenreId(null);
    setSelectedSourceId(null);
  }

  return (
    <main className="page page-wide">
      <h1>Discover</h1>

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

      {/* Filter row, hidden while searching. Three nested levels: media type
          is always here, browse mode appears once you leave "All", and the
          genre and studio dropdowns only apply to Popular. Upcoming takes no
          filters. */}
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
            <div className="discover-media-toggle" aria-label="Browse mode">
              {(
                [
                  ["popular", "Popular"],
                  ["upcoming", "Upcoming"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={
                    browseMode === value
                      ? "discover-filter-button active"
                      : "discover-filter-button"
                  }
                  aria-pressed={browseMode === value}
                  onClick={() => setBrowseMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          {mediaType !== "all" && browseMode === "popular" ? (
            <>
              <label className="discover-genre-filter">
                <span>Genre</span>
                <Dropdown
                  label="Genre"
                  value={
                    selectedGenreId != null ? String(selectedGenreId) : ""
                  }
                  // Empty string is the sentinel for "no filter" in both
                  // dropdowns, since Dropdown deals in strings and null isn't
                  // a value it can carry.
                  options={
                    genresLoading
                      ? [{ value: "", label: "Loading genres…" }]
                      : [
                          { value: "", label: "All genres" },
                          ...genres.map((genre) => ({
                            value: String(genre.id),
                            label: genre.name,
                          })),
                        ]
                  }
                  disabled={genresLoading}
                  onChange={(v) =>
                    setSelectedGenreId(v === "" ? null : Number(v))
                  }
                />
              </label>

              <label className="discover-genre-filter">
                <span>{mediaType === "movie" ? "Studio" : "Network"}</span>
                <Dropdown
                  label={mediaType === "movie" ? "Studio" : "Network"}
                  value={
                    selectedSourceId != null ? String(selectedSourceId) : ""
                  }
                  options={[
                    {
                      value: "",
                      label:
                        mediaType === "movie"
                          ? "All studios"
                          : "All networks",
                    },
                    ...sourceOptions.map((source) => ({
                      value: String(source.id),
                      label: source.name,
                    })),
                  ]}
                  onChange={(v) =>
                    setSelectedSourceId(v === "" ? null : Number(v))
                  }
                />
              </label>
            </>
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

        {/* Results grid. MediaCard paints the availability corner off
            mediaStatus, so green and amber come straight from Seerr. TMDB
            numbers films and series separately, so the key pairs id with
            mediaType to survive a mixed trending feed. */}
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
