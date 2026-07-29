// Client for the server's admin router (server/src/routes/admin.ts), mounted at
// /api/admin behind requireAdmin. Four read-only endpoints, and all four are a
// straight JSON pass-through of the host-metrics service that runs alongside
// Plex: /system, /users, /jobs and /containers.
//
// The snake_case field names below give the game away. These types mirror the
// metrics service's own JSON rather than anything this codebase shapes, and
// nothing in the middle renames or normalizes. Fields ending in _h are already
// human-formatted strings ("1.4 TB") that come down that way.
//
// Errors follow the convention documented in api/discover.ts: throw on non-2xx,
// status code only. The server collapses every upstream failure into a 502, so
// a page gets "Failed to load /api/admin/system (502)" whether the metrics box
// is down, unreachable, or answering nonsense.
//
// AdminPage drives all four through usePolledResource: /system and /containers
// at 5s, /jobs at 30s, /users at 60s. The page is tabbed so only one is live at
// a time, but a 5s poller on its own is 180 requests per 15-minute window,
// which is why the general rate limit sits at 1000 per 15 minutes. The earlier
// 200 threw 429s at the admin's own dashboard.
//
// Below the fetchers is a pile of formatting and badge-class helpers. They only
// exist to keep AdminPage's table cells declarative, and they're all pure.

// ---- GET /api/admin/system: host CPU, memory, storage, GPU, services ----

export type AdminSystemCpu = {
  model: string;
  pct: number; // 0-100, current utilization
  cores: number;
};

export type AdminSystemMem = {
  pct: number;
  used_h: string;
  total_h: string;
};

// Unix load averages. pct_1 is the one-minute figure expressed against core
// count, which is what the dashboard's bar actually renders.
export type AdminSystemLoad = {
  "1": number;
  "5": number;
  "15": number;
  pct_1: number;
};

// Degrees Celsius. Null when the host exposes no sensor for that component.
export type AdminSystemTemps = {
  cpu_c: number | null;
  gpu_c: number | null;
};

// Per-engine GPU busy percentages. `video` is the one that moves during a
// hardware transcode.
export type AdminSystemGpuEngines = {
  video: number;
  video_enhance: number;
  render: number;
  blitter: number;
  compute: number;
};

export type AdminSystemGpuUsage = {
  busy: number;
  engines: AdminSystemGpuEngines;
  freq_act: number; // MHz, current
  freq_max: number; // MHz, ceiling
};

// Null all the way down when the host has no GPU the metrics service can see.
// `hw` is whether the running transcodes are hardware accelerated; `usage` is
// null when the live counters aren't readable even though the card is known.
export type AdminSystemGpu = {
  name: string;
  transcodes: number;
  streams: number;
  hw: boolean;
  usage: AdminSystemGpuUsage | null;
} | null;

// One mounted volume. `role` is the label the metrics service assigns (media,
// system, and so on) and `online` goes false for a volume that's dropped out.
export type AdminSystemStorage = {
  label: string;
  role: string;
  fstype: string;
  pct: number;
  used_h: string;
  total_h: string;
  avail_h: string;
  online: boolean;
};

// A watched service and whether it's running. `detail` is free text from the
// metrics service, rendered as-is.
export type AdminSystemService = {
  name: string;
  up: boolean;
  detail: string;
};

// The whole /system payload.
export type AdminSystem = {
  host: string;
  uptime_s: number; // seconds; formatUptime turns this into "13d 4h"
  cpu: AdminSystemCpu;
  mem: AdminSystemMem;
  load: AdminSystemLoad;
  temps: AdminSystemTemps;
  gpu: AdminSystemGpu;
  storage: AdminSystemStorage[];
  services: AdminSystemService[];
};

// ---- GET /api/admin/users: per-user watched-versus-requested ----

// A title someone asked for and hasn't watched. `eps` is a "2/10" style
// progress string for shows and null for movies.
export type AdminUnwatchedTitle = {
  title: string;
  type: "movie" | "tv";
  size: number; // bytes
  size_h: string;
  eps: string | null;
  requested: string;
};

// One account's row in the admin users table. The gb_* pairs are the same
// number twice, raw for sorting and _h for display. `posture` is the metrics
// service's own verdict string, and postureBadgeClass below matches on it
// literally, so the two have to stay in step.
export type AdminUser = {
  user: string;
  plex_username: string;
  email: string | null;
  plex_linked: boolean;
  total_requests: number;
  available: number;
  pending: number;
  rate: number | null; // watched share, 0-100; null when they've requested nothing
  gb_requested: number;
  gb_requested_h: string;
  gb_watched: number;
  gb_watched_h: string;
  gb_unwatched: number;
  gb_unwatched_h: string;
  posture: string;
  unwatched_titles: AdminUnwatchedTitle[];
};

// Footer row: the same measures summed across everybody.
export type AdminUsersTotals = {
  users: number;
  requesters: number;
  requests: number;
  available: number;
  rate: number | null;
  gb_requested: number;
  gb_requested_h: string;
  gb_watched: number;
  gb_watched_h: string;
  gb_unwatched: number;
  gb_unwatched_h: string;
};

// `watched_definition` is a sentence explaining what counts as watched, shown
// verbatim so the table never has to imply its own methodology.
export type AdminUsersResponse = {
  users: AdminUser[];
  totals: AdminUsersTotals;
  watched_definition: string;
};

// ---- GET /api/admin/jobs: scheduled maintenance jobs on the host ----

// One cron-style job. `status` feeds jobStatusBadgeClass, which knows "ok" and
// "attention" and treats anything else as neutral.
export type AdminJob = {
  name: string;
  desc: string;
  schedule: string;
  last_run: number | null; // epoch seconds
  next_run: number | null; // epoch seconds
  status: string;
  last_line: string; // tail of the job's log
  kind: string;
  running?: boolean;
  // Cron wrapper's verdict on the last run ("exit code 0", "TIMED OUT after
  // 3600s", "KILLED (SIGKILL/OOM, rc=137)", …). Only present on wrapper-backed jobs.
  cause?: string;
  // False when the wrapper could not reach its notification channel — this
  // job's failures would go unreported. Only present on wrapper-backed jobs.
  alerting_ok?: boolean;
  // True when a per-run status file was read, so a silent stop is detectable.
  // False means health is inferred from log text only.
  heartbeat?: boolean;
};

// cache_age and generated_at come from the metrics service's own caching, so a
// fast poll here can still hand back a slightly stale snapshot.
export type AdminJobsResponse = {
  jobs: AdminJob[];
  cache_age: number; // seconds since the snapshot was built
  generated_at: number; // epoch seconds
};

// ---- GET /api/admin/containers: Docker plus native systemd services ----

// A running container. The _h fields are pre-formatted; `cpu` and `mem_pct`
// are percentages.
export type AdminDockerRow = {
  name: string;
  image: string;
  state: string;
  health: string | null;
  restarts: number;
  uptime_s: number;
  cpu: number;
  mem_used_h: string;
  mem_limit_h: string;
  mem_pct: number;
  net_rx_h: string;
  net_tx_h: string;
  blk_r_h: string;
  blk_w_h: string;
  pids: number;
};

// Plex and the *arr apps run natively under systemd on this host rather than in
// Docker, so the dashboard has to show both kinds of process side by side.
export type AdminNativeRow = {
  name: string;
  unit: string; // systemd unit name
  state: string;
  cpu: number;
  mem_used_h: string;
  pids: number;
  uptime_s: number;
};

// `docker.ok` false with an `error` string means the metrics service couldn't
// reach the Docker socket. The native rows can still be fine in that case, so
// the page renders half a table rather than an error.
export type AdminContainersResponse = {
  docker: {
    ok: boolean;
    error?: string;
    rows: AdminDockerRow[];
  };
  native: {
    rows: AdminNativeRow[];
  };
  cache_age: number;
  generated_at: number;
};

// Shared wrapper for the four fetchers. Puts the path in the thrown message,
// which matters here because AdminPage renders several polled panels at once
// and otherwise you can't tell which one failed.
async function fetchAdminJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Failed to load ${path} (${res.status})`);
  }
  return (await res.json()) as T;
}

/**
 * GET /api/admin/system. Host CPU, memory, load, temperatures, GPU and storage.
 *
 * @throws Error on any non-2xx, including the 403 a non-admin gets.
 */
export function fetchAdminSystem(): Promise<AdminSystem> {
  return fetchAdminJson<AdminSystem>("/api/admin/system");
}

/**
 * GET /api/admin/users. Watched-versus-requested for every account.
 *
 * @throws Error on any non-2xx.
 */
export function fetchAdminUsers(): Promise<AdminUsersResponse> {
  return fetchAdminJson<AdminUsersResponse>("/api/admin/users");
}

/**
 * GET /api/admin/jobs. Scheduled maintenance jobs and their last run.
 *
 * @throws Error on any non-2xx.
 */
export function fetchAdminJobs(): Promise<AdminJobsResponse> {
  return fetchAdminJson<AdminJobsResponse>("/api/admin/jobs");
}

/**
 * GET /api/admin/containers. Docker containers plus native systemd services.
 *
 * @throws Error on any non-2xx.
 */
export function fetchAdminContainers(): Promise<AdminContainersResponse> {
  return fetchAdminJson<AdminContainersResponse>("/api/admin/containers");
}

// ---- Display helpers, all pure, all used only by AdminPage ----
//
// The formatters share one rule: a value that's null, undefined or NaN renders
// as a dash placeholder, never as 0. A missing sensor reading and a genuine
// zero are different facts and the table shouldn't blur them.

/** Format uptime seconds as "13d 4h" (or "4h 12m" / "12m" for shorter spans). */
export function formatUptime(uptimeS: number): string {
  const total = Math.max(0, Math.floor(uptimeS));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  const mins = Math.floor((total % 3_600) / 60);
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

/** One decimal place plus a percent sign. */
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${value.toFixed(1)}%`;
}

/**
 * Watch rate as a percentage, printed as given. Unlike formatPct there's no
 * rounding, because the metrics service already sends a whole number here.
 */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${value}%`;
}

/** Whole degrees Celsius. Nobody needs a tenth of a degree on a dashboard. */
export function formatTempC(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${value.toFixed(0)}°C`;
}

/**
 * Colour band for a utilization bar (CPU, memory, disk): red at 90 and up,
 * amber at 70, green below that. Unreadable values go neutral grey rather than
 * green, so a dead sensor never looks healthy.
 */
export function usageBarClass(
  pct: number | null | undefined,
): "is-danger" | "is-warn" | "is-ok" | "is-neutral" {
  if (pct === null || pct === undefined || Number.isNaN(pct)) {
    return "is-neutral";
  }
  if (pct >= 90) {
    return "is-danger";
  }
  if (pct >= 70) {
    return "is-warn";
  }
  return "is-ok";
}

/** Same bands as usageBarClass but on a temperature scale: 85C red, 70C amber. */
export function tempBarClass(
  c: number | null | undefined,
): "is-danger" | "is-warn" | "is-ok" | "is-neutral" {
  if (c === null || c === undefined || Number.isNaN(c)) {
    return "is-neutral";
  }
  if (c >= 85) {
    return "is-danger";
  }
  if (c >= 70) {
    return "is-warn";
  }
  return "is-ok";
}

/**
 * Colour for a user's watch rate, and note the scale runs the other way from
 * the two above. High is good here: 70 and up is green, 40 is amber, and
 * anything under that goes red because it means someone's requesting far more
 * than they watch.
 */
export function rateBarClass(
  rate: number | null | undefined,
): "is-danger" | "is-warn" | "is-ok" | "is-neutral" {
  if (rate === null || rate === undefined || Number.isNaN(rate)) {
    return "is-neutral";
  }
  if (rate >= 70) {
    return "is-ok";
  }
  if (rate >= 40) {
    return "is-warn";
  }
  return "is-danger";
}

/**
 * Badge class for the posture flag on a user row.
 *
 * Matches on the metrics service's exact wording, so changing a string upstream
 * silently drops the row to the neutral badge instead of breaking anything.
 */
export function postureBadgeClass(posture: string): string {
  switch (posture) {
    case "Approve freely":
      return "admin-posture admin-posture-approve";
    case "Watch":
      return "admin-posture admin-posture-watch";
    case "Scrutinize":
      return "admin-posture admin-posture-scrutinize";
    default:
      return "admin-posture admin-posture-neutral";
  }
}

/**
 * Epoch seconds as "Mar 4, 09:15" in the viewer's own locale and timezone.
 *
 * No year, on purpose. These are job run times and the interesting question is
 * always "was that recent", not "what year was it".
 */
export function formatEpoch(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) {
    return "—";
  }
  const date = new Date(seconds * 1000);
  const month = date.toLocaleString(undefined, { month: "short" });
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");
  return `${month} ${day}, ${hours}:${mins}`;
}

/** Badge for a job's status string. Only "ok" and "attention" are recognised. */
export function jobStatusBadgeClass(status: string): string {
  switch (status) {
    case "ok":
      return "admin-status admin-status-ok";
    case "attention":
      return "admin-status admin-status-attention";
    default:
      return "admin-status admin-status-neutral";
  }
}

/**
 * Badge for a Docker or systemd state string. Running is green, dead in any of
 * its spellings is red, and the transitional states get amber so a container
 * mid-restart doesn't read as an outage.
 */
export function stateBadgeClass(state: string): string {
  switch (state) {
    case "running":
      return "admin-status admin-status-ok";
    case "exited":
    case "stopped":
    case "dead":
      return "admin-status admin-status-attention";
    case "restarting":
    case "created":
      return "admin-status admin-status-amber";
    default:
      return "admin-status admin-status-neutral";
  }
}

/**
 * Badge for a container's healthcheck. A container with no healthcheck defined
 * lands in the default neutral case, which is correct: no news isn't bad news.
 */
export function healthBadgeClass(health: string): string {
  switch (health) {
    case "healthy":
      return "admin-status admin-status-ok";
    case "unhealthy":
      return "admin-status admin-status-attention";
    case "starting":
      return "admin-status admin-status-amber";
    default:
      return "admin-status admin-status-neutral";
  }
}
