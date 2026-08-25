// Client-side contract for the admin Transmission downloads endpoint.
//
// This module owns the stable module-level fetcher used by usePolledResource,
// the response types, Transmission's user-facing state labels, and byte/time
// formatters. It deliberately does not reuse api/admin.ts formatRate (which
// formats percentages) or formatEpoch (which accepts epoch seconds).

/** Stable state ids emitted by server/src/transmission/normalize.ts. */
export type TransmissionTorrentState =
  | "stopped"
  | "seeding-complete"
  | "check-wait"
  | "checking"
  | "download-wait"
  | "downloading"
  | "seed-wait"
  | "seeding";

/** One normalised torrent row returned by the admin endpoint. */
export type TransmissionTorrentView = {
  hash: string;
  name: string;
  labels: string[];
  state: TransmissionTorrentState;
  status: number;
  isStalled: boolean;
  progress: number;
  sizeBytes: number;
  downloadedBytes: number;
  uploadedBytes: number;
  ratio: number;
  rateDownload: number;
  rateUpload: number;
  etaSeconds: number | null;
  peers: {
    connected: number;
    sendingToUs: number;
    gettingFromUs: number;
  };
  error: { code: number; message: string } | null;
  queuePosition: number;
  downloadDir: string;
  addedAtMs: number;
  doneAtMs: number | null;
  recheckProgress: number;
  metadataPercentComplete: number;
};

/** Torrent rows plus Transmission's session-level counts and rates. */
export type TransmissionListResponse = {
  torrents: TransmissionTorrentView[];
  session: {
    torrentCount: number;
    activeCount: number;
    pausedCount: number;
    rateDownload: number;
    rateUpload: number;
  };
};

/** Inspector-style detail returned for one torrent hash. */
export type TransmissionTorrentDetail = {
  hash: string;
  name: string;
  info: {
    totalSizeBytes: number;
    pieceCount: number;
    pieceSizeBytes: number;
    isPrivate: boolean;
    comment: string;
    creator: string;
    createdAtMs: number | null;
    addedAtMs: number;
    doneAtMs: number | null;
    lastActivityAtMs: number | null;
    downloadDir: string;
    downloadedBytes: number;
    uploadedBytes: number;
    corruptBytes: number;
    haveValidBytes: number;
    secondsDownloading: number;
    secondsSeeding: number;
    errorMessage: string | null;
  };
  files: Array<{
    name: string;
    lengthBytes: number;
    completedBytes: number;
    wanted: boolean;
    priority: number;
    progress: number;
  }>;
  peers: Array<{
    address: string;
    port: number;
    client: string;
    flags: string;
    progress: number;
    rateToClient: number;
    rateToPeer: number;
    isEncrypted: boolean;
    isIncoming: boolean;
    isUtp: boolean;
  }>;
  trackers: Array<{
    host: string;
    tier: number;
    isBackup: boolean;
    seeders: number | null;
    leechers: number | null;
    downloads: number | null;
    lastAnnounceSucceeded: boolean;
    lastAnnounceResult: string | null;
    nextAnnounceAtMs: number | null;
  }>;
};

/** Fetches the current normalised torrent list and session aggregate. */
export async function fetchTransmission(): Promise<TransmissionListResponse> {
  const response = await fetch("/api/admin/transmission/torrents");
  if (!response.ok) {
    let message = `Failed to load Transmission (${response.status})`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // Keep the status-based message when the error response is not JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as TransmissionListResponse;
}

/** Fetches Inspector-style detail for one torrent hash. */
export async function fetchTransmissionDetail(
  hash: string,
): Promise<TransmissionTorrentDetail> {
  const response = await fetch(
    `/api/admin/transmission/torrents/${encodeURIComponent(hash)}`,
  );
  if (!response.ok) {
    let message = `Failed to load torrent detail (${response.status})`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // Keep the status-based message when the error response is not JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as TransmissionTorrentDetail;
}

const STATE_LABELS: Record<TransmissionTorrentState, string> = {
  stopped: "Paused",
  "seeding-complete": "Seeding complete",
  "check-wait": "Queued to verify",
  checking: "Verifying",
  "download-wait": "Queued to download",
  downloading: "Downloading",
  "seed-wait": "Queued to seed",
  seeding: "Seeding",
};

/** Returns Transmission's user-facing wording for one state id. */
export function transmissionStateLabel(
  state: TransmissionTorrentState,
): string {
  return STATE_LABELS[state];
}

// States Transmission paints as live transfers. Everything else is drawn in
// the muted colour, mirroring how its own UI greys inactive rows.
const ACTIVE_STATES: ReadonlySet<TransmissionTorrentState> = new Set([
  "downloading",
  "seeding",
  "checking",
]);

/**
 * Modifier class for a row's progress fill: active, idle, or error.
 *
 * An error outranks the state, so a stalled-but-errored transfer reads as a
 * problem rather than as progress.
 */
export function transmissionProgressFillClass(torrent: {
  state: TransmissionTorrentState;
  error: { code: number; message: string } | null;
}): string {
  if (torrent.error !== null) {
    return "admin-download-progress-fill is-error";
  }
  return ACTIVE_STATES.has(torrent.state)
    ? "admin-download-progress-fill is-active"
    : "admin-download-progress-fill is-idle";
}

/**
 * Formats a byte count in SI units (1000-based), not binary (1024-based),
 * because that is the scale Transmission itself displays.
 *
 * "kB" is lowercase deliberately: it is both Transmission's own label and the
 * SI symbol for 1000 bytes.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "kB", "MB", "GB", "TB"] as const;
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1000)),
    units.length - 1,
  );
  const value = bytes / 1000 ** unitIndex;
  return unitIndex === 0
    ? `${Math.round(value)} ${units[unitIndex]}`
    : `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Formats a byte-per-second rate for display. */
export function formatBytesPerSecond(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Formats seconds as a duration, or the unknown-time message for null. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) {
    return "remaining time unknown";
  }

  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(wholeSeconds / 86_400);
  const hours = Math.floor((wholeSeconds % 86_400) / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${wholeSeconds}s`;
}
