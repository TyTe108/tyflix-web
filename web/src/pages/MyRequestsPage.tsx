// Everything the signed-in user has asked Tyflix to get, plus how much of
// their request quota is left. Rendered at /requests by App.tsx, inside
// ProtectedRoute and AppShell.
//
// Two independent calls: GET /api/requests through api/requests.ts for the
// list, and GET /api/me/quota through api/me.ts for the allowance. Both are
// Seerr underneath. Seerr also owns the quota rules, so the numbers here match
// whatever limits are set over there.
//
// Filtering, sorting and paging all happen in the browser against the full
// list. The endpoint returns every request in one shot, so there's nothing to
// page server-side. That's the opposite of LibraryPage, where the filtering
// runs on Plex.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
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

// Drives which of the four mutually exclusive list states renders below. The
// quota block tracks its own loading separately, since the two fetches are
// unrelated and a slow quota shouldn't hold up the list.
type LoadStatus = "loading" | "ready" | "error";

/**
 * The user's own request history with the quota banner above it.
 *
 * Read-only for members. Approve and decline buttons exist on RequestCard but
 * only the admin page passes the actions prop that renders them.
 */
export function MyRequestsPage() {
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Three-state on purpose: undefined is still loading, null means the fetch
  // failed and the banner stays hidden, an object means show it.
  const [quota, setQuota] = useState<MyQuota | null | undefined>(undefined);
  const [controls, setControls] = useState<RequestControlsState>(
    DEFAULT_REQUEST_CONTROLS,
  );
  // Filter and sort the whole list, then hand the result to the pager. Memoed
  // because applyRequestControls sorts a copy on every call and the pager
  // re-renders on each page change.
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

  // Owns the request list. Mount, then again on retry.
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

  // Owns the quota banner. Mount only, and deliberately not wired to Retry:
  // the quota is a nice-to-have, so a failure swallows the error and just
  // hides the section rather than blocking the page.
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

  // formatQuota turns a limit of 0 into "Unlimited" and flags an axis as
  // restricted when the user is out, which is what colours the line red.
  const movieQuota = quota ? formatQuota(quota.movie) : null;
  const tvQuota = quota ? formatQuota(quota.tv) : null;

  return (
    <main className="page page-wide">
      <h1>My Requests</h1>

      {/* Quota banner. Movies and TV have separate allowances in Seerr, so
          they get separate lines and either one can be the red one. */}
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

        {/* The controls row only renders when there's something to control.
            Changing any filter jumps back to page 1, so a narrower result set
            starts at the top instead of leaving usePagination to clamp you
            somewhere in the middle. The two empty states are different
            messages on purpose: no requests at all versus none matching. */}
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
