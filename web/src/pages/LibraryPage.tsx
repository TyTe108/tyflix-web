// What's actually on the Plex server, browsed Plex-style. This is where you
// land after signing in: App.tsx points "/" at /library, and the route is
// registered twice, once bare and once as /library/:mediaType, both inside
// ProtectedRoute and AppShell. The :mediaType segment is only ever "tv" or
// "movies", and anything else falls through to movies.
//
// Four endpoints under /api/library through api/library.ts: /sections once to
// find the Movies and TV Shows sections, then /sections/:key/items for the
// grid, /sections/:key/genres for the filter, and /sections/:key/first-
// characters for the A-Z rail. Plex is the only upstream. Discovery, which
// browses TMDB rather than the server, is DiscoverPage.
//
// The important thing about search here: it runs on Plex's side, not in the
// browser. Typing filters the entire library rather than the 48 items
// currently on screen, and Plex matches anywhere in the title, so "dragon"
// finds every Dragon Ball film without spelling one out. Same story for sort,
// genre and the unwatched toggle. All of it is query params on Plex.
//
// Progress bars and watched ticks are per-user, not per-server. The backend
// resolves the caller's own per-server Plex token before asking for items,
// because a shared user's general Plex token returns the owner's viewOffset
// instead of theirs.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  fetchLibraryItems,
  fetchSectionFirstCharacters,
  fetchSectionGenres,
  fetchSections,
  type LibraryFirstCharacter,
  type LibraryGenre,
  type LibraryItem,
  type LibrarySection,
  type LibrarySortKey,
} from "../api/library";
import { LibraryCard } from "../components/LibraryCard";
import { ContinueWatchingRail } from "../components/ContinueWatchingRail";
import { LibraryDetailRow } from "../components/LibraryDetailRow";
import { Dropdown } from "../components/Dropdown";
import { PaginationControls } from "../components/PaginationControls";

// Sections and items load independently, so each gets its own status.
type LoadStatus = "loading" | "ready" | "error";
type LibraryView = "grid" | "detail";

// Page size goes out as Plex's container window, so this is the real request
// size, not a client-side slice.
const PAGE_SIZE = 48;
const SEARCH_DEBOUNCE_MS = 400;
// Poster width in rem, fed to the grid as a CSS custom property. Both this and
// the view mode persist to localStorage so the library looks the same tomorrow.
const CARD_SIZE_STORAGE_KEY = "tyflix.librarycardsize";
const CARD_SIZE_DEFAULT = 8.5;
const CARD_SIZE_MIN = 6;
const CARD_SIZE_MAX = 14;
const VIEW_STORAGE_KEY = "tyflix.libraryview";
const VIEW_DEFAULT: LibraryView = "grid";

// Guards against a hand-edited localStorage value or a NaN out of Number().
function clampCardSize(value: number): number {
  if (!Number.isFinite(value)) {
    return CARD_SIZE_DEFAULT;
  }
  return Math.min(CARD_SIZE_MAX, Math.max(CARD_SIZE_MIN, value));
}

// The four localStorage helpers all swallow their own errors. Safari's private
// mode throws on both read and write, and a lost poster-size preference isn't
// worth taking the page down for.
function readStoredCardSize(): number {
  try {
    const raw = localStorage.getItem(CARD_SIZE_STORAGE_KEY);
    if (raw === null) {
      return CARD_SIZE_DEFAULT;
    }
    return clampCardSize(Number(raw));
  } catch {
    return CARD_SIZE_DEFAULT;
  }
}

function writeStoredCardSize(value: number): void {
  try {
    localStorage.setItem(CARD_SIZE_STORAGE_KEY, String(value));
  } catch {
    // private mode / quota — preference stays in-memory only
  }
}

function readStoredView(): LibraryView {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === "grid" || raw === "detail") {
      return raw;
    }
    return VIEW_DEFAULT;
  } catch {
    return VIEW_DEFAULT;
  }
}

function writeStoredView(value: LibraryView): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, value);
  } catch {
    // private mode / quota — preference stays in-memory only
  }
}

/**
 * The Plex library browser and the app's default landing page.
 *
 * Which section you're looking at comes from the URL rather than state, so the
 * Movies and TV Shows buttons navigate instead of calling a setter. That makes
 * a section linkable and survives a refresh.
 */
export function LibraryPage() {
  const { mediaType } = useParams<{ mediaType?: string }>();
  const navigate = useNavigate();

  const [sections, setSections] = useState<LibrarySection[]>([]);
  const [sectionsStatus, setSectionsStatus] = useState<LoadStatus>("loading");
  const [sectionsError, setSectionsError] = useState<string | null>(null);

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [itemsStatus, setItemsStatus] = useState<LoadStatus>("loading");
  const [itemsError, setItemsError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [sort, setSort] = useState<LibrarySortKey>("title");
  const [genreId, setGenreId] = useState<string | null>(null);
  const [unwatched, setUnwatched] = useState(false);
  const [genres, setGenres] = useState<LibraryGenre[]>([]);
  const [firstChar, setFirstChar] = useState<string | null>(null);
  const [firstChars, setFirstChars] = useState<LibraryFirstCharacter[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // What the debouncer last committed. Kept in a ref so the timer can compare
  // against it without re-running on every change, and so typing "cat", then
  // deleting back to "cat", doesn't fire a second identical request.
  const appliedSearchRef = useRef("");
  // Lazy initialisers, so localStorage is read once at mount rather than on
  // every render.
  const [cardSize, setCardSize] = useState(readStoredCardSize);
  const [view, setView] = useState<LibraryView>(readStoredView);

  // The two preference handlers write through to localStorage as they set
  // state. No effect syncing them, just a write on change.
  const onCardSizeChange = useCallback((next: number) => {
    const clamped = clampCardSize(next);
    setCardSize(clamped);
    writeStoredCardSize(clamped);
  }, []);

  const onViewChange = useCallback((next: string) => {
    if (next !== "grid" && next !== "detail") {
      return;
    }
    setView(next);
    writeStoredView(next);
  }, []);

  // "tv" in the URL, "show" in Plex's vocabulary. Everything else, including a
  // bare /library and the literal "movies", resolves to movies.
  const activeType = mediaType === "tv" ? "show" : "movie";
  // Sections come back keyed by Plex's own section key, which is what every
  // items request needs. Null until /sections resolves, which is why the items
  // effect below bails when it's missing.
  const activeSection = sections.find((s) => s.type === activeType) ?? null;
  const searchActive = debouncedSearch !== "";
  // The A-Z rail only makes sense against a title sort, and it's meaningless
  // while searching, since the search already spans the whole alphabet.
  const showAzRail =
    sort === "title" && firstChars.length > 0 && !searchActive;

  // Search debounce. Every keystroke updates `search` and restarts this timer;
  // only the settled value lands in `debouncedSearch`, which is what the items
  // effect watches. Committing a search resets to page 1 and drops any A-Z
  // letter, because a letter filter plus a search is a contradiction.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const trimmed = search.trim();
      if (trimmed === appliedSearchRef.current) {
        return;
      }
      appliedSearchRef.current = trimmed;
      setDebouncedSearch(trimmed);
      setPage(1);
      if (trimmed !== "") {
        setFirstChar(null);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [search]);

  // Owns the section list. Mount and retry only. Everything downstream keys
  // off activeSection, so a failure here replaces the whole page rather than
  // just the grid.
  useEffect(() => {
    let cancelled = false;
    setSectionsStatus("loading");
    setSectionsError(null);

    void fetchSections()
      .then((result) => {
        if (!cancelled) {
          setSections(result);
          setSectionsStatus("ready");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSections([]);
          setSectionsStatus("error");
          setSectionsError(
            err instanceof Error ? err.message : "Failed to load library sections",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Switching between Movies and TV Shows starts over at page 1. Page 7 of the
  // movies has nothing to do with page 7 of the shows.
  useEffect(() => {
    setPage(1);
  }, [activeType]);

  // Owns the two per-section filter vocabularies: the genre list and the A-Z
  // rail's letters with their counts. Both are section-scoped, so switching
  // sections has to refetch and also clear whatever genre or letter was
  // selected, since those ids don't carry across.
  useEffect(() => {
    if (!activeSection) {
      return;
    }

    setGenreId(null);
    setFirstChar(null);

    // Fired together rather than awaited in series. Neither one blocks the
    // grid, and a failure in either just leaves that control empty.
    let cancelled = false;
    void fetchSectionGenres(activeSection.key)
      .then((result) => {
        if (!cancelled) {
          setGenres(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGenres([]);
        }
      });

    void fetchSectionFirstCharacters(activeSection.key)
      .then((result) => {
        if (!cancelled) {
          setFirstChars(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFirstChars([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection]);

  // Owns the grid. Every control on the page ends up in this dependency list,
  // and each change is a fresh Plex request rather than a client-side filter,
  // which is the whole reason search and sort see the entire library instead
  // of the page you're looking at.
  //
  // Two exclusions worth knowing. firstCharacter only goes out on a title sort
  // and never alongside a search, which matches the rail being hidden in both
  // of those states. And `unwatched` false never reaches the wire at all, the
  // API module only sets the param when it's true.
  useEffect(() => {
    if (!activeSection) {
      return;
    }

    let cancelled = false;
    setItemsStatus("loading");
    setItemsError(null);

    // Plex pages by absolute offset, not page number.
    const start = (page - 1) * PAGE_SIZE;

    void fetchLibraryItems({
      sectionKey: activeSection.key,
      sort,
      start,
      size: PAGE_SIZE,
      genre: genreId ?? undefined,
      unwatched,
      firstCharacter:
        sort === "title" && firstChar !== null && !searchActive
          ? firstChar
          : undefined,
      ...(searchActive ? { query: debouncedSearch } : {}),
    })
      .then((result) => {
        if (!cancelled) {
          setItems(result.items);
          setTotalSize(result.totalSize);
          setItemsStatus("ready");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setItems([]);
          setTotalSize(0);
          setItemsStatus("error");
          setItemsError(
            err instanceof Error ? err.message : "Failed to load library items",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeSection,
    page,
    sort,
    genreId,
    unwatched,
    firstChar,
    debouncedSearch,
    searchActive,
    reloadKey,
  ]);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  // totalSize is Plex's count for the current filter set, not the section
  // total, so the pager narrows as you filter. Floored at one page so an empty
  // result still reads "1 of 1" rather than "1 of 0".
  const pageCount = Math.max(1, Math.ceil(totalSize / PAGE_SIZE));

  // Every filter handler resets to page 1. Changing a filter changes how many
  // pages exist, and holding position through that lands you somewhere
  // arbitrary. Sort does one thing more, dropping the A-Z letter, since the
  // rail only applies to a title sort.
  function onSortChange(nextSort: LibrarySortKey) {
    setSort(nextSort);
    if (nextSort !== "title") {
      setFirstChar(null);
    }
    setPage(1);
  }

  function onGenreChange(value: string) {
    setGenreId(value === "" ? null : value);
    setPage(1);
  }

  function onUnwatchedChange(checked: boolean) {
    setUnwatched(checked);
    setPage(1);
  }

  // The A-Z rail. Clicking the active letter again clears it, so a letter acts
  // as a toggle rather than a one-way selection. The explicit null branch is
  // the "All" button.
  function onFirstCharChange(label: string | null) {
    if (label === null) {
      setFirstChar(null);
    } else {
      setFirstChar((current) => (current === label ? null : label));
    }
    setPage(1);
  }

  // Sections gate the entire page, so they short-circuit before any of the
  // toolbar renders. The items status is handled inline further down, where a
  // failure only replaces the grid.
  if (sectionsStatus === "loading") {
    return (
      <main className="page page-wide">
        <h1>Library</h1>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (sectionsStatus === "error") {
    return (
      <main className="page page-wide">
        <h1>Library</h1>
        <div className="stats-error">
          <p className="error">{sectionsError ?? "Failed to load library"}</p>
          <button type="button" className="btn secondary" onClick={retry}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="page page-wide">
      <h1>Library</h1>

      {/* Resume rail, above everything and independent of the section you're
          browsing. Fetches its own data. */}
      <ContinueWatchingRail />

      {/* Toolbar: section switch on the left, display preferences on the
          right. The two section buttons navigate rather than set state, since
          the section lives in the URL. The poster-size slider only applies to
          the grid, so it disappears in detail view. */}
      <div className="library-toolbar">
        <div className="discover-media-toggle" aria-label="Library type">
          <button
            type="button"
            className={
              activeType === "movie"
                ? "discover-filter-button active"
                : "discover-filter-button"
            }
            aria-pressed={activeType === "movie"}
            onClick={() => navigate("/library/movies")}
          >
            Movies
          </button>
          <button
            type="button"
            className={
              activeType === "show"
                ? "discover-filter-button active"
                : "discover-filter-button"
            }
            aria-pressed={activeType === "show"}
            onClick={() => navigate("/library/tv")}
          >
            TV Shows
          </button>
        </div>

        <div className="library-toolbar-actions">
          <Dropdown
            label="View"
            value={view}
            options={[
              { value: "grid", label: "Grid View" },
              { value: "detail", label: "Detail View" },
            ]}
            onChange={onViewChange}
          />
          {view === "grid" ? (
            <label className="library-size">
              <span
                className="library-size-hint library-size-hint--sm"
                aria-hidden="true"
              >
                ▢
              </span>
              <input
                type="range"
                min={CARD_SIZE_MIN}
                max={CARD_SIZE_MAX}
                step={0.5}
                value={cardSize}
                aria-label="Poster size"
                onChange={(event) =>
                  onCardSizeChange(Number(event.target.value))
                }
              />
              <span
                className="library-size-hint library-size-hint--lg"
                aria-hidden="true"
              >
                ▢
              </span>
            </label>
          ) : null}
        </div>
      </div>

      {/* Filter row. All four of these are server-side: each one re-requests
          the section from Plex with different params. Nothing here filters
          `items` in place. */}
      <div className="library-controls" aria-label="Library filters">
        <label className="library-search">
          <span className="visually-hidden">
            {activeType === "movie" ? "Search Movies" : "Search TV Shows"}
          </span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              activeType === "movie" ? "Search Movies…" : "Search TV Shows…"
            }
            autoComplete="off"
          />
        </label>

        <label className="library-control">
          <span>Sort</span>
          <Dropdown
            label="Sort"
            value={sort}
            options={[
              { value: "title", label: "Title" },
              { value: "added", label: "Recently Added" },
              { value: "year", label: "Year" },
              { value: "rating", label: "Rating" },
            ]}
            onChange={(nextSort) => onSortChange(nextSort as LibrarySortKey)}
          />
        </label>

        <label className="library-control">
          <span>Genre</span>
          <Dropdown
            label="Genre"
            value={genreId ?? ""}
            options={[
              { value: "", label: "All genres" },
              ...genres.map((genre) => ({
                value: genre.id,
                label: genre.title,
              })),
            ]}
            onChange={onGenreChange}
          />
        </label>

        <label className="library-control library-control--checkbox">
          <span>Unwatched only</span>
          <input
            type="checkbox"
            checked={unwatched}
            onChange={(event) => onUnwatchedChange(event.target.checked)}
          />
        </label>
      </div>

      {itemsStatus === "loading" ? (
        <p className="muted">Loading…</p>
      ) : null}

      {itemsStatus === "error" ? (
        <div className="stats-error">
          <p className="error">{itemsError ?? "Failed to load items"}</p>
          <button type="button" className="btn secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}

      {/* Two empty states. A search that found nothing offers a way out, and
          Clear does the reset itself rather than waiting on the debounce, so
          it syncs appliedSearchRef by hand to stop the trailing timer
          committing the same empty value a second time. An empty section just
          says so. */}
      {itemsStatus === "ready" && items.length === 0 ? (
        searchActive ? (
          <div className="stats-error">
            <p className="muted">No results for &quot;{debouncedSearch}&quot;.</p>
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                appliedSearchRef.current = "";
                setSearch("");
                setDebouncedSearch("");
                setPage(1);
              }}
            >
              Clear search
            </button>
          </div>
        ) : (
          <p className="muted">No items in this section.</p>
        )
      ) : null}

      {/* The results themselves. Grid and detail render the same items with
          the same per-user watch state, just in a different shape. Keyed on
          ratingKey, which is Plex's own id and unique across the section, so
          unlike the TMDB grids elsewhere there's no composite key needed.

          The slider feeds the grid through a CSS custom property rather than
          inline widths, so one value drives the whole track sizing. The cast
          is only there because React's CSSProperties type doesn't accept
          custom properties. */}
      {itemsStatus === "ready" && items.length > 0 ? (
        <>
          <div className="library-body">
            {view === "grid" ? (
              <ul
                className="media-grid"
                style={
                  {
                    "--library-card-min": `${cardSize}rem`,
                  } as CSSProperties
                }
              >
                {items.map((item) => (
                  <li key={item.ratingKey}>
                    <LibraryCard item={item} />
                  </li>
                ))}
              </ul>
            ) : (
              <div className="library-detail-list">
                {items.map((item) => (
                  <LibraryDetailRow key={item.ratingKey} item={item} />
                ))}
              </div>
            )}
            {/* A-Z rail, alongside the results rather than above them. Plex
                supplies the buckets, including a "#" one, so the letters here
                are whatever that section actually has. Each bucket also
                carries a count, which nothing renders yet. */}
            {showAzRail ? (
              <nav className="library-az-rail" aria-label="Jump to letter">
                <button
                  type="button"
                  className={firstChar === null ? "active" : undefined}
                  aria-pressed={firstChar === null}
                  onClick={() => onFirstCharChange(null)}
                >
                  All
                </button>
                {firstChars.map((character) => (
                  <button
                    key={character.label}
                    type="button"
                    className={
                      firstChar === character.label ? "active" : undefined
                    }
                    aria-pressed={firstChar === character.label}
                    onClick={() => onFirstCharChange(character.label)}
                  >
                    {character.label}
                  </button>
                ))}
              </nav>
            ) : null}
          </div>
          <PaginationControls
            page={page}
            pageCount={pageCount}
            total={totalSize}
            canPrev={page > 1}
            canNext={page < pageCount}
            onPrev={() => setPage((p) => p - 1)}
            onNext={() => setPage((p) => p + 1)}
          />
        </>
      ) : null}
    </main>
  );
}
