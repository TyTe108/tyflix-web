export type AdminSystemCpu = {
  model: string;
  pct: number;
  cores: number;
};

export type AdminSystemMem = {
  pct: number;
  used_h: string;
  total_h: string;
};

export type AdminSystemLoad = {
  "1": number;
  "5": number;
  "15": number;
  pct_1: number;
};

export type AdminSystemTemps = {
  cpu_c: number | null;
  gpu_c: number | null;
};

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
  freq_act: number;
  freq_max: number;
};

export type AdminSystemGpu = {
  name: string;
  transcodes: number;
  streams: number;
  hw: boolean;
  usage: AdminSystemGpuUsage | null;
} | null;

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

export type AdminSystemService = {
  name: string;
  up: boolean;
  detail: string;
};

export type AdminSystem = {
  host: string;
  uptime_s: number;
  cpu: AdminSystemCpu;
  mem: AdminSystemMem;
  load: AdminSystemLoad;
  temps: AdminSystemTemps;
  gpu: AdminSystemGpu;
  storage: AdminSystemStorage[];
  services: AdminSystemService[];
};

export type AdminUnwatchedTitle = {
  title: string;
  type: "movie" | "tv";
  size: number;
  size_h: string;
  eps: string | null;
  requested: string;
};

export type AdminUser = {
  user: string;
  plex_username: string;
  email: string | null;
  plex_linked: boolean;
  total_requests: number;
  available: number;
  pending: number;
  rate: number | null;
  gb_requested: number;
  gb_requested_h: string;
  gb_watched: number;
  gb_watched_h: string;
  gb_unwatched: number;
  gb_unwatched_h: string;
  posture: string;
  unwatched_titles: AdminUnwatchedTitle[];
};

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

export type AdminUsersResponse = {
  users: AdminUser[];
  totals: AdminUsersTotals;
  watched_definition: string;
};

export type AdminJob = {
  name: string;
  desc: string;
  schedule: string;
  last_run: number | null;
  next_run: number | null;
  status: string;
  last_line: string;
  kind: string;
  running?: boolean;
};

export type AdminJobsResponse = {
  jobs: AdminJob[];
  cache_age: number;
  generated_at: number;
};

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

export type AdminNativeRow = {
  name: string;
  unit: string;
  state: string;
  cpu: number;
  mem_used_h: string;
  pids: number;
  uptime_s: number;
};

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

async function fetchAdminJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Failed to load ${path} (${res.status})`);
  }
  return (await res.json()) as T;
}

export function fetchAdminSystem(): Promise<AdminSystem> {
  return fetchAdminJson<AdminSystem>("/api/admin/system");
}

export function fetchAdminUsers(): Promise<AdminUsersResponse> {
  return fetchAdminJson<AdminUsersResponse>("/api/admin/users");
}

export function fetchAdminJobs(): Promise<AdminJobsResponse> {
  return fetchAdminJson<AdminJobsResponse>("/api/admin/jobs");
}

export function fetchAdminContainers(): Promise<AdminContainersResponse> {
  return fetchAdminJson<AdminContainersResponse>("/api/admin/containers");
}

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

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${value.toFixed(1)}%`;
}

export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${value}%`;
}

export function formatTempC(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${value.toFixed(0)}°C`;
}

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
