import { useCallback, useEffect, useState } from "react";
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
import { PaginationControls } from "../components/PaginationControls";

type LoadStatus = "loading" | "ready" | "error";

const PAGE_SIZE = 48;

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

  const activeType = mediaType === "tv" ? "show" : "movie";
  const activeSection = sections.find((s) => s.type === activeType) ?? null;
  const showAzRail = sort === "title" && firstChars.length > 0;

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

  useEffect(() => {
    setPage(1);
  }, [activeType]);

  useEffect(() => {
    if (!activeSection) {
      return;
    }

    setGenreId(null);
    setFirstChar(null);

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

  useEffect(() => {
    if (!activeSection) {
      return;
    }

    let cancelled = false;
    setItemsStatus("loading");
    setItemsError(null);

    const start = (page - 1) * PAGE_SIZE;

    void fetchLibraryItems({
      sectionKey: activeSection.key,
      sort,
      start,
      size: PAGE_SIZE,
      genre: genreId ?? undefined,
      unwatched,
      firstCharacter:
        sort === "title" && firstChar !== null ? firstChar : undefined,
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
  }, [activeSection, page, sort, genreId, unwatched, firstChar, reloadKey]);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  const pageCount = Math.max(1, Math.ceil(totalSize / PAGE_SIZE));

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

  function onFirstCharChange(label: string | null) {
    if (label === null) {
      setFirstChar(null);
    } else {
      setFirstChar((current) => (current === label ? null : label));
    }
    setPage(1);
  }

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

      <div className="discover-filters" aria-label="Library filters">
        <label className="discover-genre-filter">
          <span>Sort</span>
          <select
            value={sort}
            onChange={(event) =>
              onSortChange(event.target.value as LibrarySortKey)
            }
          >
            <option value="title">Title</option>
            <option value="added">Recently Added</option>
            <option value="year">Year</option>
            <option value="rating">Rating</option>
          </select>
        </label>

        <label className="discover-genre-filter">
          <span>Genre</span>
          <select
            value={genreId ?? ""}
            onChange={(event) => onGenreChange(event.target.value)}
          >
            <option value="">All genres</option>
            {genres.map((genre) => (
              <option key={genre.id} value={genre.id}>
                {genre.title}
              </option>
            ))}
          </select>
        </label>

        <label className="discover-genre-filter">
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

      {itemsStatus === "ready" && items.length === 0 ? (
        <p className="muted">No items in this section.</p>
      ) : null}

      {itemsStatus === "ready" && items.length > 0 ? (
        <>
          <div className="library-body">
            <ul className="media-grid">
              {items.map((item) => (
                <li key={item.ratingKey}>
                  <LibraryCard item={item} />
                </li>
              ))}
            </ul>
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
