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

export type AdminUsersResponse = {
  users: unknown[];
};

export type AdminJobsResponse = {
  jobs: unknown[];
};

export type AdminContainersResponse = {
  containers?: unknown[];
  [key: string]: unknown;
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

export function formatTempC(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return `${value.toFixed(0)}°C`;
}
