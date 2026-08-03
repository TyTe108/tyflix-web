// The admin console at /admin. One page, eight tabs, everything behind the
// admin permission bit: AdminRoute gates the route on the client, and on the
// server most of these endpoints sit behind requireAdmin. GET /api/issues/all
// is the exception, mounted behind plain requireAuth with an inline admin check
// in routes/issues.ts. Same 403 either way.
//
// Each tab is its own component with its own poller, and only the active one is
// mounted, so at most one of these is running at a time:
//
//   Requests    every user's Seerr requests, with approve and decline
//               GET /api/requests/all, every 30s
//   Issues      problem reports on titles, read-only from here
//               GET /api/issues/all, every 60s
//   Blocklist   titles an admin has removed or blocked by hand
//               GET /api/admin/blocklist, every 60s
//   Access      the self-serve access queue. Approving sends a real Plex invite
//               GET /api/admin/access-requests, every 30s
//   Users       per-user watched-versus-requested analytics
//               GET /api/admin/users, every 60s
//   System      host CPU, memory, load, temperatures, GPU, storage, services
//               GET /api/admin/system, every 5s
//   Jobs        scheduled jobs on the host and how they last went
//               GET /api/admin/jobs, every 30s
//   Containers  Docker containers and native systemd units
//               GET /api/admin/containers, every 5s
//
// Everything under /api/admin is a pass-through proxy to a small host-metrics
// service. Tyflix itself has no idea how to read a CPU temperature; it
// re-serves that service's JSON behind an admin check and nothing more.
//
// The intervals are load-bearing, not decoration. The API's rate limiter keys
// on CF-Connecting-IP, and an early budget of 200 requests per 15 minutes was
// small enough that the 5s pollers on this page locked the admin out of their
// own dashboard inside one window. It's 1000 now. Speeding up a poll here, or
// mounting several panels at once, spends that budget.
//
// The active tab lives in ?tab= (replace, not push), so a refresh comes back
// where you were and the browser Back button still leaves the page.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  accessRequestStatusBadgeClass,
  approveAccessRequest,
  denyAccessRequest,
  fetchAccessRequestSections,
  fetchAccessRequests,
  type AccessRequestView,
  type ShareableSection,
} from "../api/accessRequests";
import {
  addToBlocklist,
  fetchAdminContainers,
  fetchAdminSystem,
  fetchAdminJobs,
  fetchAdminUsers,
  fetchBlocklist,
  formatEpoch,
  formatPct,
  formatRate,
  formatTempC,
  formatUptime,
  healthBadgeClass,
  jobStatusBadgeClass,
  postureBadgeClass,
  rateBarClass,
  removeFromBlocklist,
  stateBadgeClass,
  tempBarClass,
  usageBarClass,
  type AdminBlocklistItem,
  type AdminBlocklistRemoveResponse,
  type AdminContainersResponse,
  type AdminDockerRow,
  type AdminJob,
  type AdminNativeRow,
  type AdminSystem,
  type AdminSystemGpu,
  type AdminSystemStorage,
  type AdminUnwatchedTitle,
  type AdminUser,
  type AdminUsersResponse,
} from "../api/admin";
import {
  approveRequest,
  declineRequest,
  fetchAllRequests,
} from "../api/requests";
import { Dropdown } from "../components/Dropdown";
import { RequestCard } from "../components/RequestCard";
import { PaginationControls } from "../components/PaginationControls";
import { RequestControls } from "../components/RequestControls";
import {
  applyRequestControls,
  DEFAULT_REQUEST_CONTROLS,
  type RequestControlsState,
} from "../lib/requestControls";
import {
  fetchAllIssues,
  formatIssueDate,
  issueStatusBadgeClass,
  issueStatusLabel,
  issueTypeLabel,
} from "../api/issues";
import { usePolledResource } from "../hooks/usePolledResource";
import { usePagination } from "../hooks/usePagination";

// Tab order as rendered. Also the allowlist for ?tab=, via isAdminTab.
const ADMIN_TABS = [
  { id: "requests", label: "Requests" },
  { id: "issues", label: "Issues" },
  { id: "blocklist", label: "Blocklist" },
  { id: "access", label: "Access" },
  { id: "users", label: "Users" },
  { id: "system", label: "System" },
  { id: "jobs", label: "Jobs" },
  { id: "containers", label: "Containers" },
] as const;

type AdminTab = (typeof ADMIN_TABS)[number]["id"];

const DEFAULT_TAB: AdminTab = "requests";

// Anything else in ?tab= falls back to DEFAULT_TAB rather than rendering an
// empty panel.
function isAdminTab(value: string | null): value is AdminTab {
  return ADMIN_TABS.some((tab) => tab.id === value);
}

/**
 * The admin console. Renders the tab strip and exactly one panel.
 *
 * Holds no data of its own. Every panel below fetches and polls for itself,
 * which is what keeps the unmounted tabs off the network.
 */
export function AdminPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const activeTab: AdminTab = isAdminTab(rawTab) ? rawTab : DEFAULT_TAB;

  // Switching tabs replaces the history entry instead of pushing one, so eight
  // clicks around the console don't turn Back into eight presses. Other query
  // params are carried through.
  const selectTab = useCallback(
    (tab: AdminTab) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("tab", tab);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return (
    <main className="page page-wide">
      <h1>Admin</h1>

      {/* Tab strip. Wired up as a real ARIA tablist so the ids here line up
          with the panel's aria-labelledby below. */}
      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        {ADMIN_TABS.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`admin-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`admin-tabpanel-${tab.id}`}
              className={selected ? "admin-tab active" : "admin-tab"}
              onClick={() => selectTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        className="admin-tabpanel"
        role="tabpanel"
        id={`admin-tabpanel-${activeTab}`}
        aria-labelledby={`admin-tab-${activeTab}`}
      >
        {/* One panel at a time, mounted fresh. Leaving a tab stops its poller
            and throws away its data; coming back re-fetches. */}
        {activeTab === "requests" ? <RequestsPanel /> : null}
        {activeTab === "issues" ? <IssuesPanel /> : null}
        {activeTab === "blocklist" ? <BlocklistPanel /> : null}
        {activeTab === "access" ? <AccessPanel /> : null}
        {activeTab === "users" ? <UsersPanel /> : null}
        {activeTab === "system" ? <SystemPanel /> : null}
        {activeTab === "jobs" ? <JobsPanel /> : null}
        {activeTab === "containers" ? <ContainersPanel /> : null}
      </div>
    </main>
  );
}

// System / Storage: host CPU, memory, load, temperatures, GPU and per-volume
// storage, five seconds apart. The fastest poller on the page.
//
// Every panel here follows the same shape, so this is the one place it's
// spelled out. usePolledResource fetches once on mount, then on an interval,
// and holds the last good payload when a refresh fails. That's why "error" only
// renders before the first success, and why a later failure shows up as the
// "couldn't refresh" note on UpdatedLine with stale-but-real numbers still on
// screen.
function SystemPanel() {
  const {
    data: system,
    status,
    error,
    lastUpdated,
    refresh,
  } = usePolledResource(fetchAdminSystem, 5000);

  return (
    <section className="admin-section" aria-labelledby="system-heading">
      <h2 id="system-heading">System / Storage</h2>

      {status === "loading" ? (
        <p className="muted">Loading system status…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load system status"}</p>
          <button type="button" className="btn secondary" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && system !== null ? (
        <>
          <UpdatedLine lastUpdated={lastUpdated} refreshError={error} />
          <SystemBody system={system} />
        </>
      ) : null}
    </section>
  );
}

// Requests: every user's Seerr requests, 30s poll, with the approve and
// decline buttons that write back to Seerr. Filtering and sorting are shared
// with the user-facing /requests page (applyRequestControls), then paginated at
// 20 a page. Default landing tab.
function RequestsPanel() {
  const { data, status, error, lastUpdated, refresh } = usePolledResource(
    fetchAllRequests,
    30000,
  );
  const [controls, setControls] = useState<RequestControlsState>(
    DEFAULT_REQUEST_CONTROLS,
  );
  const visible = useMemo(
    () => applyRequestControls(data ?? [], controls),
    [data, controls],
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<number | null>(null);

  // Approve or decline one request. POSTs to /api/requests/:id/approve or
  // /decline, which hands off to Seerr (and from there to Radarr or Sonarr).
  //
  // activeRequestId disables the buttons on every row while one is in flight,
  // not just the row being acted on, so a double-click can't fire two writes.
  // The refresh in `finally` runs either way, so what's on screen after an
  // action is Seerr's answer rather than an optimistic guess.
  const runAction = useCallback(
    async (id: number, action: "approve" | "decline") => {
      setActiveRequestId(id);
      setActionError(null);
      try {
        if (action === "approve") {
          await approveRequest(id);
        } else {
          await declineRequest(id);
        }
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : `Failed to ${action} request`,
        );
      } finally {
        refresh();
        setActiveRequestId(null);
      }
    },
    [refresh],
  );

  return (
    <section className="admin-section" aria-labelledby="requests-heading">
      <h2 id="requests-heading">Requests</h2>

      {status === "loading" ? (
        <p className="muted">Loading requests…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load requests"}</p>
          <button type="button" className="btn secondary" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && actionError ? (
        <p className="error admin-requests-action-error">{actionError}</p>
      ) : null}

      {/* Two different empty states below: nothing requested at all, versus
          nothing matching the current filters. Worth keeping separate, since
          the second one is the admin's own doing. */}
      {status === "ready" ? (
        <>
          <UpdatedLine lastUpdated={lastUpdated} refreshError={error} />
          {(data ?? []).length === 0 ? (
            <p className="muted">No requests yet.</p>
          ) : (
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
                    {pageItems.map((request) => (
                      <li key={request.id}>
                        <RequestCard
                          request={request}
                          showRequester
                          actions={{
                            onApprove: () =>
                              void runAction(request.id, "approve"),
                            onDecline: () =>
                              void runAction(request.id, "decline"),
                            inFlight: activeRequestId === request.id,
                            disabled: activeRequestId !== null,
                          }}
                        />
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
          )}
        </>
      ) : null}
    </section>
  );
}

// Issues: every problem report on a title, from everyone, 60s poll. Read-only
// here on purpose. Each row links to /issues/:id, which is where comments and
// status changes happen.
function IssuesPanel() {
  const { data, status, error, lastUpdated, refresh } = usePolledResource(
    fetchAllIssues,
    60000,
  );
  const issues = data ?? [];

  return (
    <section className="admin-section" aria-labelledby="issues-heading">
      <h2 id="issues-heading">Issues</h2>

      {status === "loading" ? (
        <p className="muted">Loading issues…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load issues"}</p>
          <button type="button" className="btn secondary" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" ? (
        <>
          <UpdatedLine lastUpdated={lastUpdated} refreshError={error} />
          {issues.length === 0 ? (
            <p className="muted">No issues yet.</p>
          ) : (
            <ul className="admin-requests-list">
              {issues.map((issue) => (
                <li key={issue.id} className="admin-request-row">
                  <Link to={`/issues/${issue.id}`} className="admin-issue-link">
                    <div className="admin-request-main">
                      <span className="admin-request-title">
                        {issue.media.title ?? `TMDB #${issue.media.tmdbId}`}
                      </span>
                      <span className="stats-tag">
                        {issueTypeLabel(issue.issueType)}
                      </span>
                      <span className={issueStatusBadgeClass(issue.status)}>
                        {issueStatusLabel(issue.status)}
                      </span>
                    </div>
                    <div className="admin-request-meta muted">
                      <span>Reported by {issue.createdBy.displayName}</span>
                      <span>Reported {formatIssueDate(issue.createdAt)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

const BLOCKLIST_PAGE_SIZE = 25;

const BLOCKLIST_MEDIA_TYPE_OPTIONS = [
  { value: "movie", label: "Movie" },
  { value: "tv", label: "TV" },
] as const;

type BlocklistArmedKey = string;

function blocklistRowKey(item: AdminBlocklistItem): BlocklistArmedKey {
  return `${item.mediaType}:${item.tmdbId}`;
}

// Blocklist: titles an admin has removed or blocked by hand, 60s poll. Longer
// than the request queues because this changes rarely and the rate-limit
// budget is shared with the 5s host-metrics pollers.
//
// Paging is server-side here (take/skip against Seerr) rather than usePagination
// over a full in-memory list like the other admin panels: the blocklist can
// grow without a bound the client should pull in one shot.
//
// Removing an entry is the dangerous half. Seerr deletes the matching media row
// (and cascaded request history), and if the title is still on a Plex Watchlist
// with Auto-Request on it can start downloading again within about three
// minutes. The arm step warns before the click; the response warnings say so
// again after.
function BlocklistPanel() {
  const [page, setPage] = useState(1);
  const skipRef = useRef(0);

  // usePolledResource needs a stable fetcher reference (it is an effect
  // dependency). A ref is how the current page reaches it without making the
  // fetcher identity change on every page turn.
  const fetchPage = useCallback(
    () =>
      fetchBlocklist({
        take: BLOCKLIST_PAGE_SIZE,
        skip: skipRef.current,
      }),
    [],
  );

  const { data, status, error, lastUpdated, refresh } = usePolledResource(
    fetchPage,
    60000,
  );

  const pageRef = useRef(page);
  useEffect(() => {
    if (pageRef.current === page) {
      return;
    }
    pageRef.current = page;
    skipRef.current = (page - 1) * BLOCKLIST_PAGE_SIZE;
    refresh();
  }, [page, refresh]);

  const [tmdbIdInput, setTmdbIdInput] = useState("");
  const [mediaType, setMediaType] = useState<"movie" | "tv">("movie");
  const [addBusy, setAddBusy] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [armedKey, setArmedKey] = useState<BlocklistArmedKey | null>(null);
  const [removeBusyKey, setRemoveBusyKey] = useState<BlocklistArmedKey | null>(
    null,
  );
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeResult, setRemoveResult] = useState<
    | { kind: "ok"; result: AdminBlocklistRemoveResponse }
    | { kind: "partial"; result: AdminBlocklistRemoveResponse }
    | null
  >(null);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / BLOCKLIST_PAGE_SIZE));
  const results = data?.results ?? [];

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    setAddMessage(null);
    setAddError(null);

    const trimmed = tmdbIdInput.trim();
    const parsed = Number(trimmed);
    if (
      !/^\d+$/.test(trimmed) ||
      !Number.isInteger(parsed) ||
      parsed < 1
    ) {
      setAddError("tmdbId must be a positive integer.");
      return;
    }

    setAddBusy(true);
    try {
      const result = await addToBlocklist({ tmdbId: parsed, mediaType });
      if (result.alreadyBlocklisted) {
        setAddMessage("Already on the blocklist.");
      } else {
        setAddMessage("Added to the blocklist.");
      }
      setTmdbIdInput("");
      refresh();
    } catch (err: unknown) {
      setAddError(
        err instanceof Error ? err.message : "Failed to add to blocklist",
      );
    } finally {
      setAddBusy(false);
    }
  }

  async function confirmRemove(item: AdminBlocklistItem) {
    const key = blocklistRowKey(item);
    setArmedKey(null);
    setRemoveBusyKey(key);
    setRemoveError(null);
    setRemoveResult(null);
    try {
      const result = await removeFromBlocklist(item.mediaType, item.tmdbId);
      // mediaRowDeleted false is a warning, not a success and not a failure:
      // Seerr removed the blocklist entry then failed to find a media row.
      setRemoveResult({
        kind: result.mediaRowDeleted ? "ok" : "partial",
        result,
      });
      refresh();
    } catch (err: unknown) {
      setRemoveError(
        err instanceof Error ? err.message : "Failed to remove from blocklist",
      );
    } finally {
      setRemoveBusyKey(null);
    }
  }

  return (
    <section className="admin-section" aria-labelledby="blocklist-heading">
      <h2 id="blocklist-heading">Blocklist</h2>

      {status === "loading" ? (
        <p className="muted">Loading blocklist…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load blocklist"}</p>
          <button type="button" className="btn secondary" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" ? (
        <>
          <UpdatedLine lastUpdated={lastUpdated} refreshError={error} />

          <form className="admin-blocklist-form" onSubmit={(e) => void onAdd(e)}>
            <label className="admin-blocklist-field">
              <span>TMDB ID</span>
              <input
                type="text"
                inputMode="numeric"
                value={tmdbIdInput}
                disabled={addBusy || removeBusyKey !== null}
                onChange={(event) => setTmdbIdInput(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="admin-blocklist-field">
              <span>Media type</span>
              <Dropdown
                label="Media type"
                value={mediaType}
                options={[...BLOCKLIST_MEDIA_TYPE_OPTIONS]}
                onChange={(value) => {
                  if (value === "movie" || value === "tv") {
                    setMediaType(value);
                  }
                }}
                disabled={addBusy || removeBusyKey !== null}
              />
            </label>
            <button
              type="submit"
              className="btn"
              disabled={addBusy || removeBusyKey !== null}
            >
              {addBusy ? "Adding…" : "Add to blocklist"}
            </button>
          </form>

          {addError ? (
            <p className="error admin-blocklist-form-message">{addError}</p>
          ) : null}
          {addMessage ? (
            <p className="admin-blocklist-form-message">{addMessage}</p>
          ) : null}

          {removeError ? (
            <p className="error admin-requests-action-error">{removeError}</p>
          ) : null}

          {removeResult ? (
            <div
              className={
                removeResult.kind === "partial"
                  ? "admin-blocklist-warnings admin-blocklist-warnings-partial"
                  : "admin-blocklist-warnings"
              }
              role="status"
            >
              <p>
                {removeResult.kind === "partial"
                  ? "Removed from the blocklist, but Seerr could not find a media row to delete."
                  : "Removed from the blocklist."}
              </p>
              {removeResult.result.warnings.length > 0 ? (
                <ul>
                  {removeResult.result.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {results.length === 0 ? (
            <p className="muted">No blocklist entries.</p>
          ) : (
            <>
              <ul className="admin-requests-list">
                {results.map((item) => {
                  const key = blocklistRowKey(item);
                  const armed = armedKey === key;
                  const inFlight = removeBusyKey === key;
                  return (
                    <li
                      key={key}
                      className="admin-request-row admin-blocklist-row"
                      onClick={() => {
                        if (armedKey === key) {
                          setArmedKey(null);
                        }
                      }}
                    >
                      <div className="admin-request-main">
                        <span className="admin-request-title">{item.title}</span>
                        <span className="stats-tag">{item.mediaType}</span>
                        <span className="muted">TMDB {item.tmdbId}</span>
                      </div>
                      <div
                        className="admin-request-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          className={
                            armed
                              ? "btn secondary admin-access-confirm"
                              : "btn secondary"
                          }
                          disabled={
                            inFlight ||
                            (removeBusyKey !== null && removeBusyKey !== key) ||
                            addBusy
                          }
                          onClick={() => {
                            if (armed) {
                              void confirmRemove(item);
                              return;
                            }
                            setArmedKey(key);
                          }}
                        >
                          {inFlight
                            ? "Removing…"
                            : armed
                              ? "Confirm remove? Title can be re-requested"
                              : "Remove"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <PaginationControls
                page={page}
                pageCount={pageCount}
                total={total}
                canPrev={page > 1}
                canNext={page < pageCount}
                onPrev={() => setPage((p) => Math.max(1, p - 1))}
                onNext={() => setPage((p) => Math.min(pageCount, p + 1))}
              />
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

// Access: the self-serve access-request queue, 30s poll. The one panel that can
// reach outside the house, since approving here calls Plex's sharing API and a
// real invitation email goes to whoever filled in the form at /request-access.
//
// Two data sources. The queue itself is polled, and the server reconciles it
// against plex.tv on every read: invites that were accepted out of band get
// promoted, and rows plex.tv has never heard of come back flagged
// plexInviteMissing. The library checkboxes come from a separate one-shot fetch
// at mount, because the shareable list only changes when a library is added.
//
// Both writes are deliberately two-click. The first press arms the button ("Send
// invite?" / "Confirm deny?") and the second one commits, which is the only
// thing standing between a stray click and an invitation.
function AccessPanel() {
  const { data, status, error, lastUpdated, refresh } = usePolledResource(
    fetchAccessRequests,
    30000,
  );
  const [sections, setSections] = useState<ShareableSection[] | null>(null);
  const [sectionsFailed, setSectionsFailed] = useState(false);
  const [sectionsLoaded, setSectionsLoaded] = useState(false);
  const [selectedById, setSelectedById] = useState<Record<string, number[]>>(
    {},
  );
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<"approve" | "deny" | null>(
    null,
  );
  const [denyNote, setDenyNote] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch the shareable libraries once, on mount. Failing isn't fatal: approve
  // stays available and falls back to sending no sectionIds at all, which the
  // server reads as "share everything currently shareable". sectionsLoaded is
  // what keeps the button disabled until we know which of those two worlds
  // we're in.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchAccessRequestSections();
        if (!cancelled) {
          setSections(list);
          setSectionsFailed(false);
          setSectionsLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setSections(null);
          setSectionsFailed(true);
          setSectionsLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Pending first, then newest. Anything already decided is history and can
  // sink to the bottom.
  const sorted = useMemo(() => {
    const rows = data?.requests ?? [];
    return [...rows].sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") {
        return -1;
      }
      if (b.status === "pending" && a.status !== "pending") {
        return 1;
      }
      return b.createdAt - a.createdAt;
    });
  }, [data]);

  // Lets a decided row show "Libraries: Movies, TV" instead of the stored ids.
  const sectionTitleById = useMemo(() => {
    const map = new Map<number, string>();
    for (const section of sections ?? []) {
      map.set(section.id, section.title);
    }
    return map;
  }, [sections]);

  // Which libraries are ticked for one row. Untouched rows default to every
  // library, so approving without thinking about it grants the same access
  // everyone else has.
  function selectedIdsFor(requestId: string): number[] {
    const explicit = selectedById[requestId];
    if (explicit !== undefined) {
      return explicit;
    }
    return (sections ?? []).map((s) => s.id);
  }

  // Disarms whichever button was armed and drops any typed deny note.
  function clearConfirm() {
    setConfirmId(null);
    setConfirmKind(null);
    setDenyNote("");
  }

  // Changing the library selection disarms the confirm, so the second click
  // can't send an invite for a set of libraries the admin just changed.
  function toggleSection(requestId: string, sectionId: number) {
    clearConfirm();
    const current = selectedIdsFor(requestId);
    const next = current.includes(sectionId)
      ? current.filter((id) => id !== sectionId)
      : [...current, sectionId];
    setSelectedById((prev) => ({ ...prev, [requestId]: next }));
  }

  // The irreversible one. POST .../:id/approve invites the applicant's email to
  // the Plex server and shares the chosen libraries, and Plex mails them.
  //
  // Passing sectionIds undefined is not the same as passing an empty array: the
  // server treats undefined as "everything shareable" and rejects an empty
  // array outright. Undefined is only used when the sections fetch failed and
  // there's nothing sensible to pick from.
  const runApprove = useCallback(
    async (id: string, sectionIds: number[] | undefined) => {
      setActiveId(id);
      setActionError(null);
      clearConfirm();
      try {
        if (sectionIds === undefined) {
          await approveAccessRequest(id);
        } else {
          await approveAccessRequest(id, sectionIds);
        }
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Failed to approve request",
        );
      } finally {
        refresh();
        setActiveId(null);
      }
    },
    [refresh],
  );

  // Deny is local. Plex is never contacted, the applicant isn't told, and the
  // optional note is for the admin's own benefit. The store lets the same email
  // apply again after 90 days.
  const runDeny = useCallback(
    async (id: string, note: string) => {
      setActiveId(id);
      setActionError(null);
      clearConfirm();
      try {
        await denyAccessRequest(id, note);
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : "Failed to deny request",
        );
      } finally {
        refresh();
        setActiveId(null);
      }
    },
    [refresh],
  );

  return (
    <section className="admin-section" aria-labelledby="access-heading">
      <h2 id="access-heading">Access</h2>

      {status === "loading" ? (
        <p className="muted">Loading access requests…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load access requests"}</p>
          <button type="button" className="btn secondary" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && actionError ? (
        <p className="error admin-requests-action-error">{actionError}</p>
      ) : null}

      {status === "ready" ? (
        <>
          <UpdatedLine lastUpdated={lastUpdated} refreshError={error} />
          {/* reconciledAt null means the server got the queue out of its own
              store but couldn't check plex.tv, so an "invited" row here might
              already have been accepted. Say so rather than imply it's live. */}
          {data?.reconciledAt === null ? (
            <p className="muted admin-access-reconcile-note">
              Plex could not be reached. Statuses shown are from the last known
              store state.
            </p>
          ) : null}
          {sorted.length === 0 ? (
            <p className="muted">No access requests</p>
          ) : (
            <ul className="admin-requests-list">
              {sorted.map((request) => {
                // Per-row gating. The picker only renders when we actually have
                // a section list, and approve stays disabled until the sections
                // fetch has settled one way or the other and there's at least
                // one library ticked (or nothing to tick).
                const selectedIds = selectedIdsFor(request.id);
                const showPicker =
                  !sectionsFailed &&
                  sections !== null &&
                  sections.length > 0;
                const canApprove =
                  request.status === "pending" &&
                  sectionsLoaded &&
                  (sectionsFailed || selectedIds.length > 0);

                return (
                  <AccessRequestRow
                    key={request.id}
                    request={request}
                    sections={showPicker ? sections : null}
                    selectedIds={selectedIds}
                    sectionTitleById={sectionTitleById}
                    confirmingApprove={
                      confirmId === request.id && confirmKind === "approve"
                    }
                    confirmingDeny={
                      confirmId === request.id && confirmKind === "deny"
                    }
                    denyNote={confirmId === request.id ? denyNote : ""}
                    inFlight={activeId === request.id}
                    canApprove={canApprove}
                    onToggleSection={(sectionId) =>
                      toggleSection(request.id, sectionId)
                    }
                    // Clicking anywhere else on an armed row disarms it. The
                    // controls inside stop propagation so they don't trip this.
                    onRowClick={() => {
                      if (confirmId === request.id) {
                        clearConfirm();
                      }
                    }}
                    onDenyNoteChange={setDenyNote}
                    // First click arms, second click sends the invite. Only one
                    // row can be armed at a time, since confirmId is a single id.
                    onApproveClick={() => {
                      if (
                        confirmId === request.id &&
                        confirmKind === "approve"
                      ) {
                        void runApprove(
                          request.id,
                          sectionsFailed ? undefined : selectedIds,
                        );
                        return;
                      }
                      setConfirmId(request.id);
                      setConfirmKind("approve");
                      setDenyNote("");
                    }}
                    onDenyClick={() => {
                      if (confirmId === request.id && confirmKind === "deny") {
                        void runDeny(request.id, denyNote);
                        return;
                      }
                      setConfirmId(request.id);
                      setConfirmKind("deny");
                      setDenyNote("");
                    }}
                  />
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

// One row in the access queue. Presentational: every decision (armed or not,
// which libraries are ticked, whether approve is allowed) is made by AccessPanel
// and passed down, so this only renders and reports clicks.
//
// Pending rows get the library checkboxes and the action buttons. Decided rows
// keep the note, the granted libraries and any admin note, which is the record
// of what was handed out and why.
function AccessRequestRow({
  request,
  sections,
  selectedIds,
  sectionTitleById,
  confirmingApprove,
  confirmingDeny,
  denyNote,
  inFlight,
  canApprove,
  onToggleSection,
  onRowClick,
  onDenyNoteChange,
  onApproveClick,
  onDenyClick,
}: {
  request: AccessRequestView;
  sections: ShareableSection[] | null;
  selectedIds: number[];
  sectionTitleById: Map<number, string>;
  confirmingApprove: boolean;
  confirmingDeny: boolean;
  denyNote: string;
  inFlight: boolean;
  canApprove: boolean;
  onToggleSection: (sectionId: number) => void;
  onRowClick: () => void;
  onDenyNoteChange: (value: string) => void;
  onApproveClick: () => void;
  onDenyClick: () => void;
}) {
  const pending = request.status === "pending";

  // Stored ids resolved back to library names. A section that's since been
  // removed from sharing falls back to "Section 3" rather than disappearing.
  const grantedTitles =
    request.sectionIds === null
      ? []
      : request.sectionIds.map(
          (id) => sectionTitleById.get(id) ?? `Section ${id}`,
        );

  return (
    <li className="admin-request-row admin-access-row" onClick={onRowClick}>
      {/* Identity line: who asked, where the row stands, and whether they told
          us they already have a Plex account. "invite not on Plex" is the
          reconcile flag, and it means we think we invited them but plex.tv
          shows neither a pending invite nor a share. */}
      <div className="admin-request-main">
        <span className="admin-request-title">{request.name}</span>
        <span className={accessRequestStatusBadgeClass(request.status)}>
          {request.status}
        </span>
        {request.plexInviteMissing ? (
          <span className="stats-tag admin-access-missing-tag">
            invite not on Plex
          </span>
        ) : null}
        <span className="stats-tag">
          {request.hasPlexAccount ? "Has Plex account" : "No Plex account"}
        </span>
      </div>

      <div className="admin-request-meta muted">
        <span>{request.email}</span>
        {request.plexUsername ? (
          <span>Plex: {request.plexUsername}</span>
        ) : null}
        <span>Requested {formatEpoch(request.createdAt)}</span>
        {request.decidedAt !== null ? (
          <span>Decided {formatEpoch(request.decidedAt)}</span>
        ) : null}
      </div>

      {/* What they typed into the form. Then the audit trail: which libraries
          were granted, any private admin note, and the IP the form came from. */}
      <p className="admin-access-note">{request.note}</p>

      {grantedTitles.length > 0 ? (
        <p className="admin-access-granted muted">
          Libraries: {grantedTitles.join(", ")}
        </p>
      ) : null}

      {request.adminNote ? (
        <p className="admin-access-admin-note muted">
          Admin note: {request.adminNote}
        </p>
      ) : null}

      {request.sourceIp ? (
        <p className="admin-access-ip muted">{request.sourceIp}</p>
      ) : null}

      {/* Libraries to share. Pending rows only, and the whole fieldset goes
          disabled while a write is in flight. stopPropagation keeps ticking a
          box from counting as a click on the row. */}
      {pending && sections !== null ? (
        <fieldset
          className="admin-access-sections"
          disabled={inFlight}
          onClick={(e) => e.stopPropagation()}
        >
          <legend className="visually-hidden">Libraries to share</legend>
          {sections.map((section) => (
            <label key={section.id} className="admin-access-section">
              <input
                type="checkbox"
                checked={selectedIds.includes(section.id)}
                onChange={() => onToggleSection(section.id)}
              />
              {section.title}
            </label>
          ))}
        </fieldset>
      ) : null}

      {/* The deny note only appears once Deny is armed. 280 characters, matching
          the server's cap, and it's private to the admin. */}
      {pending && confirmingDeny ? (
        <label
          className="admin-access-deny-note"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="muted">Optional note</span>
          <input
            type="text"
            value={denyNote}
            maxLength={280}
            disabled={inFlight}
            placeholder="Why deny?"
            onChange={(e) => onDenyNoteChange(e.target.value)}
          />
        </label>
      ) : null}

      {/* Actions. The label is the confirmation state: "Approve" arms, "Send
          invite?" is the click that actually emails someone. */}
      {pending ? (
        <div
          className="admin-request-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className={confirmingApprove ? "btn admin-access-confirm" : "btn"}
            disabled={inFlight || !canApprove}
            onClick={onApproveClick}
          >
            {inFlight
              ? "Working…"
              : confirmingApprove
                ? "Send invite?"
                : "Approve"}
          </button>
          <button
            type="button"
            className={
              confirmingDeny ? "btn secondary admin-access-confirm" : "btn secondary"
            }
            disabled={inFlight}
            onClick={onDenyClick}
          >
            {confirmingDeny ? "Confirm deny?" : "Deny"}
          </button>
        </div>
      ) : null}
    </li>
  );
}

// Users: watched-versus-requested for every account, 60s poll. How much each
// person asked for, how much of it they actually watched, and how many GB are
// sitting on disk untouched.
//
// These numbers arrive precomputed from the host-metrics service through the
// /api/admin proxy. They're not the same code path as the Home page's own
// stats, which the app computes itself in analytics/watchedVsRequested.ts.
function UsersPanel() {
  const { data, status, error, lastUpdated, refresh } = usePolledResource(
    fetchAdminUsers,
    60000,
  );

  return (
    <section className="admin-section" aria-labelledby="users-heading">
      <h2 id="users-heading">Users</h2>

      {status === "loading" ? (
        <p className="muted">Loading users…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load users"}</p>
          <button type="button" className="btn secondary" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && data !== null ? (
        <>
          <UpdatedLine lastUpdated={lastUpdated} refreshError={error} />
          <UsersBody data={data} />
        </>
      ) : null}
    </section>
  );
}

// The sortable table. Opens on unwatched GB, largest first, because that's the
// column worth looking at: who's sitting on the most storage they never played.
function UsersBody({ data }: { data: AdminUsersResponse }) {
  const { users, totals, watched_definition } = data;
  const [sortKey, setSortKey] = useState<UserSortKey>("gb_unwatched");
  const [sortDir, setSortDir] = useState<SortDir>(-1);

  const sorted = useMemo(
    () => [...users].sort((a, b) => compareUsers(a, b, sortKey, sortDir)),
    [users, sortKey, sortDir],
  );

  // Clicking the active column flips direction. Switching columns picks the
  // direction that's useful first: A to Z for the text columns, biggest first
  // for the numbers.
  const onSort = useCallback(
    (key: UserSortKey) => {
      if (key === sortKey) {
        setSortDir((dir) => (dir === 1 ? -1 : 1));
        return;
      }
      setSortKey(key);
      setSortDir(key === "user" || key === "posture" ? 1 : -1);
    },
    [sortKey],
  );

  return (
    <div className="admin-users">
      {/* House totals across every account, with the same inline rate bar the
          per-user rows use. */}
      <p className="admin-users-totals muted">
        {totals.users} user{totals.users === 1 ? "" : "s"} ·{" "}
        {totals.requesters} requester{totals.requesters === 1 ? "" : "s"} ·{" "}
        {totals.gb_requested_h} requested · {totals.gb_watched_h} watched ·{" "}
        {totals.gb_unwatched_h} unwatched · rate{" "}
        <span className="admin-bar-inline" aria-hidden="true">
          <span
            className={`stats-bar-fill ${rateBarClass(totals.rate)}`}
            style={{ width: `${barWidth(totals.rate)}%` }}
          />
        </span>
        {formatRate(totals.rate)}
      </p>

      {/* Not a <table>. It's a CSS grid with ARIA table roles, so the header
          cells and the row cells have to stay in the same order by hand. */}
      <div className="admin-users-scroll">
        <div className="admin-users-list" role="table">
          <div className="admin-users-row admin-users-header" role="row">
            {USER_SORT_HEADERS.map(({ key, label }) => (
              <UsersSortHeader
                key={key}
                label={label}
                sortKey={key}
                activeKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
              />
            ))}
          </div>

          {sorted.map((user) => (
            <UserListRow key={user.user} user={user} />
          ))}
        </div>
      </div>

      {/* The metrics service ships its own definition of "watched" as a string.
          Printing it beats hardcoding a caption that could drift from whatever
          rule that service is applying. */}
      <p className="stats-caption muted">{watched_definition}</p>
    </div>
  );
}

// Sortable columns. Each key is a field on AdminUser, which is what lets
// sortFieldValue index straight into the row.
type UserSortKey =
  | "user"
  | "total_requests"
  | "gb_requested"
  | "gb_watched"
  | "gb_unwatched"
  | "rate"
  | "posture";

// 1 ascending, -1 descending. Multiplied into the comparison result.
type SortDir = 1 | -1;

// Column order for the header row. Must match the cell order in UserRowCells.
const USER_SORT_HEADERS: { key: UserSortKey; label: string }[] = [
  { key: "user", label: "User" },
  { key: "total_requests", label: "Requests" },
  { key: "gb_requested", label: "Requested" },
  { key: "gb_watched", label: "Watched" },
  { key: "gb_unwatched", label: "Unwatched" },
  { key: "rate", label: "Rate" },
  { key: "posture", label: "Posture" },
];

// Missing values sort as negative infinity, so a user with no watch rate lands
// at the bottom of a descending sort instead of jumping to the top.
function sortFieldValue(
  user: AdminUser,
  key: UserSortKey,
): string | number {
  const value = user[key];
  if (value === null || value === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  if (typeof value === "number" && Number.isNaN(value)) {
    return Number.NEGATIVE_INFINITY;
  }
  return value;
}

// localeCompare for the two text columns, plain numeric ordering for the rest.
// A mismatched pair (shouldn't happen, since a key is one type across all rows)
// takes the numeric branch, where the non-numeric side reads as negative
// infinity.
function compareUsers(
  a: AdminUser,
  b: AdminUser,
  key: UserSortKey,
  dir: SortDir,
): number {
  const av = sortFieldValue(a, key);
  const bv = sortFieldValue(b, key);

  let cmp = 0;
  if (typeof av === "string" && typeof bv === "string") {
    cmp = av.localeCompare(bv);
  } else {
    const an = typeof av === "number" ? av : Number.NEGATIVE_INFINITY;
    const bn = typeof bv === "number" ? bv : Number.NEGATIVE_INFINITY;
    cmp = an === bn ? 0 : an < bn ? -1 : 1;
  }

  return cmp * dir;
}

// One column header. Carries aria-sort so the sort state isn't only in the
// caret glyph.
function UsersSortHeader({
  label,
  sortKey,
  activeKey,
  sortDir,
  onSort,
}: {
  label: string;
  sortKey: UserSortKey;
  activeKey: UserSortKey;
  sortDir: SortDir;
  onSort: (key: UserSortKey) => void;
}) {
  const active = sortKey === activeKey;
  const ariaSort = active
    ? sortDir === 1
      ? "ascending"
      : "descending"
    : "none";

  return (
    <div
      className={
        active ? "admin-users-cell is-sorted" : "admin-users-cell"
      }
      role="columnheader"
      aria-sort={ariaSort}
    >
      <button
        type="button"
        className="admin-users-sort"
        onClick={() => onSort(sortKey)}
      >
        <span>{label}</span>
        {active ? (
          <span className="admin-users-sort-caret" aria-hidden="true">
            {sortDir === 1 ? "▲" : "▼"}
          </span>
        ) : null}
      </button>
    </div>
  );
}

// A user row, expandable into their unwatched titles. Someone with nothing
// unwatched renders as a plain row, since there'd be nothing behind the
// disclosure triangle.
function UserListRow({ user }: { user: AdminUser }) {
  if (user.unwatched_titles.length === 0) {
    return (
      <div className="admin-users-row" role="row">
        <UserRowCells user={user} />
      </div>
    );
  }

  return (
    <details className="admin-user-details">
      <summary className="admin-users-row admin-users-row-expandable">
        <UserRowCells user={user} />
      </summary>
      <UnwatchedTitlesList titles={user.unwatched_titles} />
    </details>
  );
}

// The seven cells, in USER_SORT_HEADERS order. Shared by the plain row and the
// expandable <summary> so both stay aligned to the same grid.
//
// The "unlinked" badge is the row's plex_linked flag, meaning no Plex account
// was matched behind these numbers. The requests cell reads available over
// total, with anything still pending called out separately.
function UserRowCells({ user }: { user: AdminUser }) {
  return (
    <>
      <div className="admin-users-cell admin-users-col-user" role="cell">
        <span className="admin-users-name">{user.user}</span>
        <span className="muted admin-users-plex">{user.plex_username}</span>
        {!user.plex_linked ? (
          <span className="admin-users-unlinked">unlinked</span>
        ) : null}
      </div>
      <div className="admin-users-cell admin-users-col-num" role="cell">
        <span>
          {user.available}/{user.total_requests}
        </span>
        {user.pending > 0 ? (
          <span className="muted admin-users-pending">
            (+{user.pending} pending)
          </span>
        ) : null}
      </div>
      <div className="admin-users-cell admin-users-col-num" role="cell">
        {user.gb_requested_h}
      </div>
      <div className="admin-users-cell admin-users-col-num" role="cell">
        {user.gb_watched_h}
      </div>
      <div className="admin-users-cell admin-users-col-num" role="cell">
        {user.gb_unwatched_h}
      </div>
      <div className="admin-users-cell admin-users-col-num" role="cell">
        <span className="admin-bar-inline" aria-hidden="true">
          <span
            className={`stats-bar-fill ${rateBarClass(user.rate)}`}
            style={{ width: `${barWidth(user.rate)}%` }}
          />
        </span>
        {formatRate(user.rate)}
      </div>
      <div className="admin-users-cell admin-users-col-posture" role="cell">
        <span className={postureBadgeClass(user.posture)}>{user.posture}</span>
      </div>
    </>
  );
}

// What one user requested and never played, with size on disk. The key is
// composed from type, title and request date because these rows carry no id.
function UnwatchedTitlesList({ titles }: { titles: AdminUnwatchedTitle[] }) {
  return (
    <ul className="admin-unwatched-list">
      {titles.map((item) => (
        <li key={`${item.type}:${item.title}:${item.requested}`}>
          <div className="stats-unwatched-row">
            <span className="stats-unwatched-title">{item.title}</span>
            <span className="stats-tag">{item.type === "tv" ? "TV" : "Movie"}</span>
          </div>
          <div className="stats-unwatched-meta muted">
            <span>{item.size_h}</span>
            {item.eps != null ? <span>{item.eps}</span> : null}
            <span>Requested {item.requested}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// Jobs: the scheduled work running on the host, 30s poll. Read-only. Nothing
// here starts or stops a job; it's a window onto the schedule, when each one
// last ran and what it said.
function JobsPanel() {
  const { data, status, error, lastUpdated, refresh } = usePolledResource(
    fetchAdminJobs,
    30000,
  );

  return (
    <section className="admin-section" aria-labelledby="jobs-heading">
      <h2 id="jobs-heading">Jobs</h2>

      {status === "loading" ? (
        <p className="muted">Loading jobs…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load jobs"}</p>
          <button type="button" className="btn secondary" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && data !== null ? (
        <>
          <UpdatedLine lastUpdated={lastUpdated} refreshError={error} />
          <JobsBody jobs={data.jobs} />
        </>
      ) : null}
    </section>
  );
}

// Job table. Same hand-rolled grid as the users table. Each entry can carry a
// last_line, the tail of that job's own output, printed under its row when
// there's something to show.
function JobsBody({ jobs }: { jobs: AdminJob[] }) {
  return (
    <div className="admin-jobs">
      <div className="admin-jobs-scroll">
        <div className="admin-jobs-list" role="table">
          <div className="admin-jobs-row admin-jobs-header" role="row">
            <div className="admin-jobs-cell" role="columnheader">
              Job
            </div>
            <div className="admin-jobs-cell" role="columnheader">
              Schedule
            </div>
            <div className="admin-jobs-cell" role="columnheader">
              Last run
            </div>
            <div className="admin-jobs-cell" role="columnheader">
              Next run
            </div>
            <div className="admin-jobs-cell" role="columnheader">
              Status
            </div>
          </div>

          {jobs.map((job) => (
            <div key={job.name} className="admin-jobs-entry">
              <div className="admin-jobs-row" role="row">
                <div className="admin-jobs-cell admin-jobs-col-job" role="cell">
                  <span className="admin-jobs-name">{job.name}</span>
                  <span className="muted admin-jobs-desc">{job.desc}</span>
                  <span className="stats-tag admin-jobs-kind">{job.kind}</span>
                  {/* Healthy cron with no heartbeat is the informative case:
                      the row looks fine but we cannot prove the job is still
                      running. Skip services (heartbeat is meaningless) and
                      non-ok rows (already flagged). */}
                  {job.kind === "cron" &&
                  job.status === "ok" &&
                  job.heartbeat === false ? (
                    <span className="muted admin-jobs-no-heartbeat">
                      no heartbeat
                    </span>
                  ) : null}
                </div>
                <div className="admin-jobs-cell" role="cell">
                  {job.schedule}
                </div>
                <div className="admin-jobs-cell" role="cell">
                  {formatEpoch(job.last_run)}
                </div>
                <div className="admin-jobs-cell" role="cell">
                  {formatEpoch(job.next_run)}
                </div>
                <div className="admin-jobs-cell admin-jobs-col-status" role="cell">
                  <span className={jobStatusBadgeClass(job.status)}>
                    {job.status}
                  </span>
                  {job.alerting_ok === false ? (
                    <span className="admin-status admin-jobs-alerting-broken">
                      alerting broken
                    </span>
                  ) : null}
                </div>
              </div>
              {job.last_line ? (
                <p className="admin-jobs-last-line muted">{job.last_line}</p>
              ) : null}
              {/* Suppress cause when the job is ok ("exit code 0" is noise on
                  every healthy row) or when it equals last_line (wrapper had
                  no captured output, so last_line already is the cause). */}
              {job.status !== "ok" &&
              job.cause &&
              job.cause !== job.last_line ? (
                <p className="admin-jobs-cause muted">{job.cause}</p>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Containers: Docker containers and native systemd services, five seconds
// apart. The other fast poller. Read-only, like Jobs.
function ContainersPanel() {
  const { data, status, error, lastUpdated, refresh } = usePolledResource(
    fetchAdminContainers,
    5000,
  );

  return (
    <section className="admin-section" aria-labelledby="containers-heading">
      <h2 id="containers-heading">Containers</h2>

      {status === "loading" ? (
        <p className="muted">Loading containers…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load containers"}</p>
          <button type="button" className="btn secondary" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && data !== null ? (
        <>
          <UpdatedLine lastUpdated={lastUpdated} refreshError={error} />
          <ContainersBody data={data} />
        </>
      ) : null}
    </section>
  );
}

// The "Updated 14:32" line every panel prints above its data. Renders nothing
// until the first successful fetch.
//
// The "couldn't refresh" suffix is the only place a failed poll shows up once a
// panel has data. Without it a dead metrics service looks identical to a very
// quiet one.
function UpdatedLine({
  lastUpdated,
  refreshError,
}: {
  lastUpdated: number | null;
  refreshError: string | null;
}) {
  if (lastUpdated === null) {
    return null;
  }

  return (
    <p className="muted">
      Updated {new Date(lastUpdated).toLocaleTimeString()}
      {refreshError ? " · couldn't refresh" : ""}
    </p>
  );
}

// Two tables, because the server runs both. The Docker half can come back
// ok:false with its own error message while the native systemd half is fine, so
// each degrades independently.
function ContainersBody({ data }: { data: AdminContainersResponse }) {
  return (
    <div className="admin-containers">
      <h3 className="admin-subheading">Docker</h3>
      {data.docker.ok ? (
        <DockerTable rows={data.docker.rows} />
      ) : (
        <p className="error">{data.docker.error ?? "Docker unavailable"}</p>
      )}

      <h3 className="admin-subheading">Native services</h3>
      <NativeTable rows={data.native.rows} />
    </div>
  );
}

// Per-container stats: state and health badges, CPU and memory with inline
// bars, network totals, uptime. The image, pid count, restart count and block
// IO ride along under the container name instead of getting columns.
function DockerTable({ rows }: { rows: AdminDockerRow[] }) {
  return (
    <div className="admin-containers-scroll">
      <div className="admin-containers-list admin-containers-docker" role="table">
        <div className="admin-containers-row admin-containers-header" role="row">
          <div className="admin-containers-cell" role="columnheader">
            Container
          </div>
          <div className="admin-containers-cell" role="columnheader">
            State
          </div>
          <div className="admin-containers-cell" role="columnheader">
            CPU
          </div>
          <div className="admin-containers-cell" role="columnheader">
            Memory
          </div>
          <div className="admin-containers-cell" role="columnheader">
            Net
          </div>
          <div className="admin-containers-cell" role="columnheader">
            Uptime
          </div>
        </div>

        {rows.map((row) => (
          <div key={row.name} className="admin-containers-row" role="row">
            <div className="admin-containers-cell admin-containers-col-name" role="cell">
              <span className="admin-containers-name">{row.name}</span>
              <span className="muted admin-containers-sub">{row.image}</span>
              <span className="muted admin-containers-sub">
                pids {row.pids} · restarts {row.restarts} · blk {row.blk_r_h}/
                {row.blk_w_h}
              </span>
            </div>
            <div className="admin-containers-cell admin-containers-col-badges" role="cell">
              <span className={stateBadgeClass(row.state)}>{row.state}</span>
              {row.health != null ? (
                <span className={healthBadgeClass(row.health)}>{row.health}</span>
              ) : null}
            </div>
            <div className="admin-containers-cell" role="cell">
              <span className="admin-bar-inline" aria-hidden="true">
                <span
                  className={`stats-bar-fill ${usageBarClass(row.cpu)}`}
                  style={{ width: `${barWidth(row.cpu)}%` }}
                />
              </span>
              {formatPct(row.cpu)}
            </div>
            <div className="admin-containers-cell" role="cell">
              <span>
                {row.mem_used_h} / {row.mem_limit_h}
              </span>
              <span className="muted admin-containers-sub">
                <span className="admin-bar-inline" aria-hidden="true">
                  <span
                    className={`stats-bar-fill ${usageBarClass(row.mem_pct)}`}
                    style={{ width: `${barWidth(row.mem_pct)}%` }}
                  />
                </span>
                {formatPct(row.mem_pct)}
              </span>
            </div>
            <div className="admin-containers-cell" role="cell">
              <span>↓ {row.net_rx_h}</span>
              <span className="muted admin-containers-sub">↑ {row.net_tx_h}</span>
            </div>
            <div className="admin-containers-cell" role="cell">
              {formatUptime(row.uptime_s)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// The same shape for the host's native systemd units. These rows carry no
// health status and no memory limit, so those columns drop out and the unit
// name sits under the service name instead.
function NativeTable({ rows }: { rows: AdminNativeRow[] }) {
  return (
    <div className="admin-containers-scroll">
      <div className="admin-containers-list admin-containers-native" role="table">
        <div className="admin-containers-row admin-containers-header" role="row">
          <div className="admin-containers-cell" role="columnheader">
            Service
          </div>
          <div className="admin-containers-cell" role="columnheader">
            State
          </div>
          <div className="admin-containers-cell" role="columnheader">
            CPU
          </div>
          <div className="admin-containers-cell" role="columnheader">
            Memory
          </div>
          <div className="admin-containers-cell" role="columnheader">
            PIDs
          </div>
          <div className="admin-containers-cell" role="columnheader">
            Uptime
          </div>
        </div>

        {rows.map((row) => (
          <div key={row.unit} className="admin-containers-row" role="row">
            <div className="admin-containers-cell admin-containers-col-name" role="cell">
              <span className="admin-containers-name">{row.name}</span>
              <span className="muted admin-containers-sub">{row.unit}</span>
            </div>
            <div className="admin-containers-cell admin-containers-col-badges" role="cell">
              <span className={stateBadgeClass(row.state)}>{row.state}</span>
            </div>
            <div className="admin-containers-cell" role="cell">
              <span className="admin-bar-inline" aria-hidden="true">
                <span
                  className={`stats-bar-fill ${usageBarClass(row.cpu)}`}
                  style={{ width: `${barWidth(row.cpu)}%` }}
                />
              </span>
              {formatPct(row.cpu)}
            </div>
            <div className="admin-containers-cell" role="cell">
              {row.mem_used_h}
            </div>
            <div className="admin-containers-cell" role="cell">
              {row.pids}
            </div>
            <div className="admin-containers-cell" role="cell">
              {formatUptime(row.uptime_s)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Percentage clamped to 0-100 for a bar's inline width. Null, undefined and
// NaN all collapse to an empty bar, which is what keeps a missing sensor from
// rendering a nonsense stripe.
function barWidth(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

// The system tab's contents: six tiles across the top, then the GPU engine
// breakdown, per-volume storage, and a service up/down list.
//
// GPU data is optional all the way down. `gpu` can be null (no GPU reported)
// and `gpu.usage` can be null on top of that, so every read of it is guarded
// and the formatters print a dash placeholder instead.
function SystemBody({ system }: { system: AdminSystem }) {
  const { cpu, mem, load, temps, gpu, storage, services } = system;
  const gpuUsage = gpu?.usage;
  const load1 = Number.isFinite(load["1"]) ? load["1"].toFixed(2) : "—";
  const load5 = Number.isFinite(load["5"]) ? load["5"].toFixed(2) : "—";
  const load15 = Number.isFinite(load["15"]) ? load["15"].toFixed(2) : "—";
  const gpuFrequency =
    gpuUsage &&
    Number.isFinite(gpuUsage.freq_act) &&
    Number.isFinite(gpuUsage.freq_max)
      ? `${gpuUsage.freq_act}/${gpuUsage.freq_max} MHz`
      : "—";

  return (
    <div className="admin-system">
      <p className="admin-host">
        <strong>{system.host}</strong>
        <span className="muted"> · up {formatUptime(system.uptime_s)}</span>
      </p>

      {/* Six tiles: CPU, memory, load, CPU temperature, GPU busy and the
          transcoder. Same layout each time, a headline number over a bar, and
          the bar's colour is a threshold class (usageBarClass, tempBarClass)
          rather than anything computed here. */}
      <div className="admin-tiles">
        <div className="admin-tile">
          <p className="admin-tile-label">CPU</p>
          <p className="admin-tile-value">{formatPct(cpu.pct)}</p>
          <p className="muted admin-tile-meta">{cpu.cores} cores</p>
          <div className="stats-bar">
            <div
              className={`stats-bar-fill ${usageBarClass(cpu.pct)}`}
              style={{ width: `${barWidth(cpu.pct)}%` }}
            />
          </div>
        </div>

        <div className="admin-tile">
          <p className="admin-tile-label">Memory</p>
          <p className="admin-tile-value">{formatPct(mem.pct)}</p>
          <p className="muted admin-tile-meta">
            {mem.used_h} / {mem.total_h}
          </p>
          <div className="stats-bar">
            <div
              className={`stats-bar-fill ${usageBarClass(mem.pct)}`}
              style={{ width: `${barWidth(mem.pct)}%` }}
            />
          </div>
        </div>

        <div className="admin-tile">
          <p className="admin-tile-label">Load (1m)</p>
          <p className="admin-tile-value">{load1}</p>
          <p className="muted admin-tile-meta">
            {load5} · {load15} (5/15m) · {formatPct(load.pct_1)} of {cpu.cores}
          </p>
          <div className="stats-bar">
            <div
              className={`stats-bar-fill ${usageBarClass(load.pct_1)}`}
              style={{ width: `${barWidth(load.pct_1)}%` }}
            />
          </div>
        </div>

        <div className="admin-tile">
          <p className="admin-tile-label">CPU temp</p>
          <p className="admin-tile-value">{formatTempC(temps.cpu_c)}</p>
          <p className="muted admin-tile-meta">
            package · GPU {formatTempC(temps.gpu_c)}
          </p>
          <div className="stats-bar">
            <div
              className={`stats-bar-fill ${tempBarClass(temps.cpu_c)}`}
              style={{ width: `${barWidth(temps.cpu_c)}%` }}
            />
          </div>
        </div>

        <div className="admin-tile">
          <p className="admin-tile-label">GPU busy</p>
          <p className="admin-tile-value">{formatPct(gpuUsage?.busy)}</p>
          <p className="muted admin-tile-meta">{gpuFrequency}</p>
          {gpu !== null ? (
            <div className="stats-bar">
              <div
                className={`stats-bar-fill ${
                  gpuUsage && Number.isFinite(gpuUsage.busy)
                    ? "is-info"
                    : "is-neutral"
                }`}
                style={{ width: `${barWidth(gpuUsage?.busy)}%` }}
              />
            </div>
          ) : null}
        </div>

        {/* Transcoder count is the one tile with no bar: it's a count of live
            Plex transcodes, with the GPU name, stream count and whether
            hardware acceleration is in play underneath. */}
        <div className="admin-tile">
          <p className="admin-tile-label">Transcoder</p>
          <p className="admin-tile-value">{gpu?.transcodes ?? "—"}</p>
          <p className="muted admin-tile-meta">
            {gpu
              ? `${gpu.name} · ${gpu.streams} stream${gpu.streams === 1 ? "" : "s"}${gpu.hw ? " · HW" : ""}`
              : "—"}
          </p>
        </div>
      </div>

      <GpuBlock gpu={gpu} />

      {/* Every volume the metrics service reports, including ones it can see
          but not reach. */}
      <h3 className="admin-subheading">Storage</h3>
      <ul className="admin-storage-list">
        {storage.map((drive) => (
          <StorageRow key={drive.label} drive={drive} />
        ))}
      </ul>

      {/* Plain up/down dots for the services the metrics service watches, with
          whatever detail string it attached. */}
      <h3 className="admin-subheading">Services</h3>
      <ul className="admin-services-list">
        {services.map((svc) => (
          <li key={svc.name}>
            <span
              className={
                svc.up ? "admin-service-dot up" : "admin-service-dot down"
              }
              aria-hidden="true"
            />
            <span className="admin-service-name">{svc.name}</span>
            <span className="muted admin-service-detail">
              {svc.up ? "up" : "down"}
              {svc.detail ? ` · ${svc.detail}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Per-engine GPU utilisation. The Video and Enhance engines are the ones that
// move during a hardware transcode, which is what makes this block worth having
// separately from the single "GPU busy" tile.
//
// Two levels of absence, handled differently: no GPU at all gets "No GPU data",
// and a GPU with no usage sample still shows its name and transcode counts.
function GpuBlock({ gpu }: { gpu: AdminSystemGpu }) {
  if (gpu === null) {
    return (
      <div className="admin-gpu">
        <h3 className="admin-subheading">GPU</h3>
        <p className="muted">No GPU data.</p>
      </div>
    );
  }

  const usage = gpu.usage;
  const engines = usage?.engines;
  const engineRows = engines
    ? [
        { label: "Video", value: engines.video },
        { label: "Enhance", value: engines.video_enhance },
        { label: "Render", value: engines.render },
        { label: "Blitter", value: engines.blitter },
        { label: "Compute", value: engines.compute },
      ]
    : [];

  return (
    <div className="admin-gpu">
      <h3 className="admin-subheading">GPU</h3>
      <p className="admin-gpu-name">{gpu.name}</p>
      <p className="muted admin-gpu-meta">
        {gpu.transcodes} transcoder{gpu.transcodes === 1 ? "" : "s"} ·{" "}
        {gpu.streams} stream{gpu.streams === 1 ? "" : "s"}
        {gpu.hw ? " · HW" : ""}
        {usage != null ? ` · busy ${formatPct(usage.busy)}` : null}
      </p>
      {engines != null ? (
        <div className="admin-engines">
          {engineRows.map(({ label, value }) => (
            <div className="admin-engine-row" key={label}>
              <span className="admin-engine-label">{label}</span>
              <div className="stats-bar">
                <div
                  className={`stats-bar-fill ${Number.isFinite(value) ? "is-info" : "is-neutral"}`}
                  style={{ width: `${barWidth(value)}%` }}
                />
              </div>
              <span className="admin-engine-value">{formatPct(value)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted admin-gpu-meta">No GPU usage data.</p>
      )}
    </div>
  );
}

// One volume. An offline drive keeps its row and its role, with an Offline tag
// and no usage figures, so a disk that dropped off is visibly missing instead
// of quietly gone from the list.
function StorageRow({ drive }: { drive: AdminSystemStorage }) {
  if (!drive.online) {
    return (
      <li className="admin-storage-row offline">
        <div className="admin-storage-head">
          <span className="admin-storage-label">{drive.label}</span>
          <span className="admin-tag">Offline</span>
        </div>
        <p className="muted admin-storage-meta">{drive.role}</p>
      </li>
    );
  }

  const pct = barWidth(drive.pct);

  return (
    <li className="admin-storage-row">
      <div className="admin-storage-head">
        <span className="admin-storage-label">{drive.label}</span>
        <span className="muted">
          {drive.used_h} / {drive.total_h} · {formatPct(drive.pct)}
        </span>
      </div>
      <p className="muted admin-storage-meta">
        {drive.role} · {drive.fstype} · {drive.avail_h} free
      </p>
      <div
        className="stats-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${drive.label} usage`}
      >
        <div
          className={`stats-bar-fill ${usageBarClass(drive.pct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </li>
  );
}
