// Prev / Next with a "Page 2 of 7 · 134 total" readout between them.
//
// Three pages use it: the Library grid, MyRequestsPage, and the requests tab of
// AdminPage. It holds no state and does no arithmetic. Callers work out the
// page maths themselves and pass the answers in, which is what lets the same
// bar sit over server-paged results (Library) and client-sliced arrays
// (requests) without knowing the difference.
type PaginationControlsProps = {
  page: number; // 1-based, for display
  pageCount: number;
  total: number; // items across all pages, not on this one
  // Enabled state for each button. Every caller today derives these from the
  // page bounds; this component doesn't work them out itself.
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
};

/**
 * Pagination bar, or nothing when everything already fits on one page.
 *
 * Callers can render it unconditionally at the bottom of a list.
 */
export function PaginationControls({
  page,
  pageCount,
  total,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: PaginationControlsProps) {
  if (pageCount <= 1) {
    return null;
  }

  return (
    <nav className="pagination" aria-label="Pagination">
      <button
        type="button"
        className="btn secondary"
        onClick={onPrev}
        disabled={!canPrev}
        aria-label="Previous page"
      >
        Prev
      </button>
      <span className="muted pagination-label">
        Page {page} of {pageCount} · {total} total
      </span>
      <button
        type="button"
        className="btn secondary"
        onClick={onNext}
        disabled={!canNext}
        aria-label="Next page"
      >
        Next
      </button>
    </nav>
  );
}
