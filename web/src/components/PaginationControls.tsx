type PaginationControlsProps = {
  page: number;
  pageCount: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
};

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
