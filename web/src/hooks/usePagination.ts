// Client-side pagination over an array the caller already holds. Two callers,
// both request tables: the requests panel on AdminPage and MyRequestsPage. Both
// fetch everything in one go and page through it in the browser. The issue
// lists don't paginate.
//
// This is not how the Library pages work. Those page on Plex's side, because
// the library is far too big to hold in memory and filtering a single page in
// the browser would filter the wrong thing. Don't reach for this hook for
// anything server-paged.

import { useCallback, useEffect, useState } from "react";

type Pagination<T> = {
  pageItems: T[]; // the current slice, ready to map over
  page: number; // 1-based and already clamped
  pageCount: number; // at least 1, even with nothing to show
  total: number;
  setPage: (page: number) => void;
  next: () => void;
  prev: () => void;
  canPrev: boolean;
  canNext: boolean;
};

/**
 * Slices `items` into pages and tracks which one you're on.
 *
 * Handles the awkward case where the list shrinks underneath you. Filter a
 * table down while sitting on page 5 and the page index would point past the
 * end, so the returned `page` is always clamped into range and the stored state
 * follows it. Callers get a valid page number no matter what they do to the
 * array.
 */
export function usePagination<T>(items: T[], pageSize = 20): Pagination<T> {
  const [page, setPage] = useState(1);

  // safePage is what everything below actually uses. Deriving the clamp on each
  // render means the returned page is correct on the very render where the list
  // shrank, rather than one render later.
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);

  // Writes the clamp back into state so the next interaction starts from a real
  // page number. Purely a catch-up on the derived value above, which is why it
  // guards on inequality instead of setting unconditionally.
  useEffect(() => {
    if (page !== safePage) {
      setPage(safePage);
    }
  }, [page, safePage]);

  const pageItems = items.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Both steppers clamp on their own rather than leaning on the effect above,
  // so a click at either end is a no-op instead of a bounce.
  const next = useCallback(() => {
    setPage((current) => Math.min(current + 1, pageCount));
  }, [pageCount]);

  const prev = useCallback(() => {
    setPage((current) => Math.max(current - 1, 1));
  }, []);

  return {
    pageItems,
    page: safePage,
    pageCount,
    total,
    setPage,
    next,
    prev,
    canPrev: safePage > 1,
    canNext: safePage < pageCount,
  };
}
