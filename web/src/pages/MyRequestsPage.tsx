import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchMyRequests,
  type RequestView,
} from "../api/requests";
import {
  fetchMyQuota,
  formatQuota,
  type MyQuota,
} from "../api/me";
import { RequestCard } from "../components/RequestCard";
import { PaginationControls } from "../components/PaginationControls";
import { RequestControls } from "../components/RequestControls";
import {
  applyRequestControls,
  DEFAULT_REQUEST_CONTROLS,
  type RequestControlsState,
} from "../lib/requestControls";
import { usePagination } from "../hooks/usePagination";

type LoadStatus = "loading" | "ready" | "error";

export function MyRequestsPage() {
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [quota, setQuota] = useState<MyQuota | null | undefined>(undefined);
  const [controls, setControls] = useState<RequestControlsState>(
    DEFAULT_REQUEST_CONTROLS,
  );
  const visible = useMemo(
    () => applyRequestControls(requests, controls),
    [requests, controls],
  );
  const {
    pageItems,
    page,
    pageCount,
    total,
    canPrev,
    canNext,
    next,
    prev,
    setPage,
  } = usePagination(visible, 20);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchMyRequests()
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setRequests(rows);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setRequests([]);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load requests",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;

    void fetchMyQuota()
      .then((value) => {
        if (!cancelled) {
          setQuota(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQuota(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const movieQuota = quota ? formatQuota(quota.movie) : null;
  const tvQuota = quota ? formatQuota(quota.tv) : null;

  return (
    <main className="page page-wide">
      <h1>My Requests</h1>

      {quota === undefined ? (
        <p className="muted">Loading request quota…</p>
      ) : quota ? (
        <section aria-labelledby="request-quota-heading">
          <h2 id="request-quota-heading">Request quota</h2>
          <div className="muted">
            <div className={movieQuota?.restricted ? "error" : undefined}>
              Movies: {movieQuota?.text}
            </div>
            <div className={tvQuota?.restricted ? "error" : undefined}>
              TV: {tvQuota?.text}
            </div>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="my-requests-heading">
        <h2 id="my-requests-heading" className="visually-hidden">
          Request list
        </h2>

        {status === "loading" ? (
          <p className="muted">Loading your requests…</p>
        ) : null}

        {status === "error" ? (
          <div className="stats-error">
            <p className="error">{error ?? "Failed to load requests"}</p>
            <button type="button" className="btn secondary" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}

        {status === "ready" && requests.length === 0 ? (
          <p className="muted">
            No requests yet.{" "}
            <Link to="/discover">Discover something</Link> to request.
          </p>
        ) : null}

        {status === "ready" && requests.length > 0 ? (
          <>
            <RequestControls
              value={controls}
              onChange={(nextControls) => {
                setControls(nextControls);
                setPage(1);
              }}
            />
            {visible.length === 0 ? (
              <p className="muted">No requests match these filters.</p>
            ) : (
              <>
                <ul className="request-card-list">
                  {pageItems.map((row) => (
                    <li key={row.id}>
                      <RequestCard request={row} />
                    </li>
                  ))}
                </ul>
                <PaginationControls
                  page={page}
                  pageCount={pageCount}
                  total={total}
                  canPrev={canPrev}
                  canNext={canNext}
                  onPrev={prev}
                  onNext={next}
                />
              </>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}
