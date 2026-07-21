import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  fetchLibraryItems,
  fetchSections,
  type LibraryItem,
  type LibrarySection,
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

  const activeType = mediaType === "tv" ? "show" : "movie";
  const activeSection = sections.find((s) => s.type === activeType) ?? null;

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

    let cancelled = false;
    setItemsStatus("loading");
    setItemsError(null);

    const start = (page - 1) * PAGE_SIZE;

    void fetchLibraryItems({
      sectionKey: activeSection.key,
      sort: "title",
      start,
      size: PAGE_SIZE,
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
  }, [activeSection, page, reloadKey]);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  const pageCount = Math.max(1, Math.ceil(totalSize / PAGE_SIZE));

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
          <ul className="media-grid">
            {items.map((item) => (
              <li key={item.ratingKey}>
                <LibraryCard item={item} />
              </li>
            ))}
          </ul>
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
