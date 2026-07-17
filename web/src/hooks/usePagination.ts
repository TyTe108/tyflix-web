import { useCallback, useEffect, useState } from "react";

type Pagination<T> = {
  pageItems: T[];
  page: number;
  pageCount: number;
  total: number;
  setPage: (page: number) => void;
  next: () => void;
  prev: () => void;
  canPrev: boolean;
  canNext: boolean;
};

export function usePagination<T>(items: T[], pageSize = 20): Pagination<T> {
  const [page, setPage] = useState(1);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);

  useEffect(() => {
    if (page !== safePage) {
      setPage(safePage);
    }
  }, [page, safePage]);

  const pageItems = items.slice((safePage - 1) * pageSize, safePage * pageSize);

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
