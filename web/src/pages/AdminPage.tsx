import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  fetchAdminContainers,
  fetchAdminSystem,
  fetchAdminJobs,
  fetchAdminUsers,
  formatEpoch,
  formatPct,
  formatRate,
  formatTempC,
  formatUptime,
  healthBadgeClass,
  jobStatusBadgeClass,
  postureBadgeClass,
  stateBadgeClass,
  type AdminContainersResponse,
  type AdminDockerRow,
  type AdminJob,
  type AdminJobsResponse,
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
  type RequestView,
} from "../api/requests";
import { RequestCard } from "../components/RequestCard";
import {
  fetchAllIssues,
  formatIssueDate,
  issueStatusBadgeClass,
  issueStatusLabel,
  issueTypeLabel,
  type IssueView,
} from "../api/issues";

type LoadStatus = "loading" | "ready" | "error";

const ADMIN_TABS = [
  { id: "requests", label: "Requests" },
  { id: "issues", label: "Issues" },
  { id: "users", label: "Users" },
  { id: "system", label: "System" },
  { id: "jobs", label: "Jobs" },
  { id: "containers", label: "Containers" },
] as const;

type AdminTab = (typeof ADMIN_TABS)[number]["id"];

const DEFAULT_TAB: AdminTab = "requests";

function isAdminTab(value: string | null): value is AdminTab {
  return ADMIN_TABS.some((tab) => tab.id === value);
}

export function AdminPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const activeTab: AdminTab = isAdminTab(rawTab) ? rawTab : DEFAULT_TAB;

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
        {activeTab === "requests" ? <RequestsPanel /> : null}
        {activeTab === "issues" ? <IssuesPanel /> : null}
        {activeTab === "users" ? <UsersPanel /> : null}
        {activeTab === "system" ? <SystemPanel /> : null}
        {activeTab === "jobs" ? <JobsPanel /> : null}
        {activeTab === "containers" ? <ContainersPanel /> : null}
      </div>
    </main>
  );
}

function SystemPanel() {
  const [system, setSystem] = useState<AdminSystem | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchAdminSystem()
      .then((data) => {
        if (cancelled) {
          return;
        }
        setSystem(data);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setSystem(null);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load system status",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <section className="admin-section" aria-labelledby="system-heading">
      <h2 id="system-heading">System / Storage</h2>

      {status === "loading" ? (
        <p className="muted">Loading system status…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load system status"}</p>
          <button type="button" className="btn secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && system !== null ? (
        <SystemBody system={system} />
      ) : null}
    </section>
  );
}

function pendingFirst(requests: RequestView[]): RequestView[] {
  return [...requests].sort((a, b) => {
    const aPending = a.requestStatus === "pending" ? 0 : 1;
    const bPending = b.requestStatus === "pending" ? 0 : 1;
    return aPending - bPending;
  });
}

function RequestsPanel() {
  const [requests, setRequests] = useState<RequestView[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchAllRequests()
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setRequests(pendingFirst(rows));
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

  const runAction = useCallback(
    async (id: number, action: "approve" | "decline") => {
      setActiveRequestId(id);
      setActionError(null);
      try {
        const updated =
          action === "approve"
            ? await approveRequest(id)
            : await declineRequest(id);
        setRequests((rows) =>
          pendingFirst(rows.map((row) => (row.id === id ? updated : row))),
        );
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : `Failed to ${action} request`,
        );

        // Approval failures may persist the request as failed server-side.
        try {
          const rows = await fetchAllRequests();
          setRequests(pendingFirst(rows));
        } catch {
          // Preserve the action error and currently displayed rows.
        }
      } finally {
        setActiveRequestId(null);
      }
    },
    [],
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
          <button type="button" className="btn secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && actionError ? (
        <p className="error admin-requests-action-error">{actionError}</p>
      ) : null}

      {status === "ready" && requests.length === 0 ? (
        <p className="muted">No requests yet.</p>
      ) : null}

      {status === "ready" && requests.length > 0 ? (
        <ul className="request-card-list">
          {requests.map((request) => (
            <li key={request.id}>
              <RequestCard
                request={request}
                showRequester
                actions={{
                  onApprove: () => void runAction(request.id, "approve"),
                  onDecline: () => void runAction(request.id, "decline"),
                  inFlight: activeRequestId === request.id,
                  disabled: activeRequestId !== null,
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function IssuesPanel() {
  const [issues, setIssues] = useState<IssueView[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchAllIssues()
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setIssues(rows);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setIssues([]);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load issues",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <section className="admin-section" aria-labelledby="issues-heading">
      <h2 id="issues-heading">Issues</h2>

      {status === "loading" ? (
        <p className="muted">Loading issues…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load issues"}</p>
          <button type="button" className="btn secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && issues.length === 0 ? (
        <p className="muted">No issues yet.</p>
      ) : null}

      {status === "ready" && issues.length > 0 ? (
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
      ) : null}
    </section>
  );
}

function UsersPanel() {
  const [data, setData] = useState<AdminUsersResponse | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchAdminUsers()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setData(response);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setData(null);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load users",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <section className="admin-section" aria-labelledby="users-heading">
      <h2 id="users-heading">Users</h2>

      {status === "loading" ? (
        <p className="muted">Loading users…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load users"}</p>
          <button type="button" className="btn secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && data !== null ? (
        <UsersBody data={data} />
      ) : null}
    </section>
  );
}

function UsersBody({ data }: { data: AdminUsersResponse }) {
  const { users, totals, watched_definition } = data;

  return (
    <div className="admin-users">
      <p className="admin-users-totals muted">
        {totals.users} user{totals.users === 1 ? "" : "s"} ·{" "}
        {totals.requesters} requester{totals.requesters === 1 ? "" : "s"} ·{" "}
        {totals.gb_requested_h} requested · {totals.gb_watched_h} watched ·{" "}
        {totals.gb_unwatched_h} unwatched · rate {formatRate(totals.rate)}
      </p>

      <div className="admin-users-scroll">
        <div className="admin-users-list" role="table">
          <div className="admin-users-row admin-users-header" role="row">
            <div className="admin-users-cell" role="columnheader">
              User
            </div>
            <div className="admin-users-cell" role="columnheader">
              Requests
            </div>
            <div className="admin-users-cell" role="columnheader">
              Requested
            </div>
            <div className="admin-users-cell" role="columnheader">
              Watched
            </div>
            <div className="admin-users-cell" role="columnheader">
              Unwatched
            </div>
            <div className="admin-users-cell" role="columnheader">
              Rate
            </div>
            <div className="admin-users-cell" role="columnheader">
              Posture
            </div>
          </div>

          {users.map((user) => (
            <UserListRow key={user.user} user={user} />
          ))}
        </div>
      </div>

      <p className="stats-caption muted">{watched_definition}</p>
    </div>
  );
}

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
        {formatRate(user.rate)}
      </div>
      <div className="admin-users-cell admin-users-col-posture" role="cell">
        <span className={postureBadgeClass(user.posture)}>{user.posture}</span>
      </div>
    </>
  );
}

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

function JobsPanel() {
  const [data, setData] = useState<AdminJobsResponse | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchAdminJobs()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setData(response);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setData(null);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load jobs",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <section className="admin-section" aria-labelledby="jobs-heading">
      <h2 id="jobs-heading">Jobs</h2>

      {status === "loading" ? (
        <p className="muted">Loading jobs…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load jobs"}</p>
          <button type="button" className="btn secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && data !== null ? (
        <JobsBody jobs={data.jobs} />
      ) : null}
    </section>
  );
}

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
                </div>
              </div>
              {job.last_line ? (
                <p className="admin-jobs-last-line muted">{job.last_line}</p>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ContainersPanel() {
  const [data, setData] = useState<AdminContainersResponse | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    void fetchAdminContainers()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setData(response);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setData(null);
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "Failed to load containers",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <section className="admin-section" aria-labelledby="containers-heading">
      <h2 id="containers-heading">Containers</h2>

      {status === "loading" ? (
        <p className="muted">Loading containers…</p>
      ) : null}

      {status === "error" ? (
        <div className="stats-error">
          <p className="error">{error ?? "Failed to load containers"}</p>
          <button type="button" className="btn secondary" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}

      {status === "ready" && data !== null ? (
        <ContainersBody data={data} />
      ) : null}
    </section>
  );
}

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
              {formatPct(row.cpu)}
            </div>
            <div className="admin-containers-cell" role="cell">
              <span>
                {row.mem_used_h} / {row.mem_limit_h}
              </span>
              <span className="muted admin-containers-sub">
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

function SystemBody({ system }: { system: AdminSystem }) {
  const { cpu, mem, load, temps, gpu, storage, services } = system;

  return (
    <div className="admin-system">
      <p className="admin-host">
        <strong>{system.host}</strong>
        <span className="muted"> · up {formatUptime(system.uptime_s)}</span>
      </p>

      <dl className="admin-metrics">
        <div>
          <dt>CPU</dt>
          <dd>
            {formatPct(cpu.pct)}
            <span className="muted admin-metric-sub">
              {cpu.cores} cores · {cpu.model}
            </span>
          </dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>
            {formatPct(mem.pct)}
            <span className="muted admin-metric-sub">
              {mem.used_h} / {mem.total_h}
            </span>
          </dd>
        </div>
        <div>
          <dt>Load</dt>
          <dd>
            {load["1"]} / {load["5"]} / {load["15"]}
            <span className="muted admin-metric-sub">
              1m {formatPct(load.pct_1)}
            </span>
          </dd>
        </div>
        <div>
          <dt>Temps</dt>
          <dd>
            CPU {formatTempC(temps.cpu_c)}
            <span className="muted admin-metric-sub">
              GPU {formatTempC(temps.gpu_c)}
            </span>
          </dd>
        </div>
      </dl>

      <GpuBlock gpu={gpu} />

      <h3 className="admin-subheading">Storage</h3>
      <ul className="admin-storage-list">
        {storage.map((drive) => (
          <StorageRow key={drive.label} drive={drive} />
        ))}
      </ul>

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
        <dl className="admin-engines">
          <div>
            <dt>Video</dt>
            <dd>{formatPct(engines.video)}</dd>
          </div>
          <div>
            <dt>Enhance</dt>
            <dd>{formatPct(engines.video_enhance)}</dd>
          </div>
          <div>
            <dt>Render</dt>
            <dd>{formatPct(engines.render)}</dd>
          </div>
          <div>
            <dt>Blitter</dt>
            <dd>{formatPct(engines.blitter)}</dd>
          </div>
          <div>
            <dt>Compute</dt>
            <dd>{formatPct(engines.compute)}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

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

  const pct = Math.min(100, Math.max(0, drive.pct));

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
        <div className="stats-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}
