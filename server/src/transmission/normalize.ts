// Maps Transmission RPC `arguments` blobs into the admin downloads view.
//
// Units on the view: sizes are bytes, rates are bytes per second, timestamps
// are milliseconds since epoch (the Ms suffix used elsewhere in this codebase).
// etaSeconds is seconds when known and null when Transmission reports a
// negative eta. Those negative values are more than one sentinel; this file
// does not try to tell them apart.
//
// The mapping is strict. A missing field or a value of the wrong type throws
// TransmissionUpstreamError (status 502) naming the field and the torrent
// hash. Rows are not skipped and values are not coerced. That diverges from
// seerr/client.ts, which drops malformed rows: hiding a torrent from a
// downloads view is a lie, unlike dropping one row of a paginated media list.
// The same strictness is the protocol pin for this phase. A field renamed by a
// future Transmission release fails by name in the suite instead of surfacing
// as a null in the UI, which is why recordedSamples.ts exists.

import { TransmissionUpstreamError } from "./client";

export type TransmissionTorrentState =
  | "stopped" // status 0, isFinished false
  | "seeding-complete" // status 0, isFinished true
  | "check-wait" // 1
  | "checking" // 2
  | "download-wait" // 3
  | "downloading" // 4
  | "seed-wait" // 5
  | "seeding"; // 6

export type TransmissionTorrentView = {
  hash: string; // hashString
  name: string;
  labels: string[];
  state: TransmissionTorrentState;
  status: number; // raw, kept so nothing is lost
  isStalled: boolean;
  progress: number; // percentDone, 0..1
  sizeBytes: number; // sizeWhenDone
  downloadedBytes: number; // sizeWhenDone - leftUntilDone
  uploadedBytes: number; // uploadedEver
  ratio: number; // uploadRatio
  rateDownload: number; // bytes per second
  rateUpload: number; // bytes per second
  etaSeconds: number | null;
  peers: { connected: number; sendingToUs: number; gettingFromUs: number };
  error: { code: number; message: string } | null;
  queuePosition: number;
  downloadDir: string;
  addedAtMs: number;
  doneAtMs: number | null;
  recheckProgress: number; // 0..1, only meaningful at status 2
  metadataPercentComplete: number; // 0..1
};

export type TransmissionListResponse = {
  torrents: TransmissionTorrentView[];
  session: {
    torrentCount: number;
    activeCount: number;
    pausedCount: number;
    rateDownload: number; // bytes per second
    rateUpload: number; // bytes per second
  };
};

/** Normalised Inspector-style detail for one torrent. */
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

/**
 * Maps one detailed torrent-get row into Inspector-style detail.
 *
 * files and fileStats are parallel arrays aligned only by index. A length
 * mismatch is rejected rather than truncated, because truncation would either
 * hide a file or attach another file's wanted/priority values.
 */
export function normalizeTorrentDetail(raw: unknown): TransmissionTorrentDetail {
  const row = requireObject(raw, "torrent detail row");
  const hash = readOptionalString(row, "hashString") ?? "unknown";
  const hashString = readString(row, "hashString", hash);
  const files = readArray(row, "files", hashString);
  const fileStats = readArray(row, "fileStats", hashString);
  if (files.length !== fileStats.length) {
    throw fieldError(
      "files/fileStats",
      hashString,
      `length mismatch: files length ${files.length}, fileStats length ${fileStats.length}`,
    );
  }

  const peers = readArray(row, "peers", hashString);
  const trackerStats = readArray(row, "trackerStats", hashString);
  const dateCreated = readNumber(row, "dateCreated", hashString);
  const addedDate = readNumber(row, "addedDate", hashString);
  const doneDate = readNumber(row, "doneDate", hashString);
  const activityDate = readNumber(row, "activityDate", hashString);
  const errorString = readString(row, "errorString", hashString);

  return {
    hash: hashString,
    name: readString(row, "name", hashString),
    info: {
      totalSizeBytes: readNumber(row, "totalSize", hashString),
      pieceCount: readNumber(row, "pieceCount", hashString),
      pieceSizeBytes: readNumber(row, "pieceSize", hashString),
      isPrivate: readBoolean(row, "isPrivate", hashString),
      comment: readString(row, "comment", hashString),
      creator: readString(row, "creator", hashString),
      createdAtMs: dateCreated === 0 ? null : dateCreated * 1000,
      addedAtMs: addedDate * 1000,
      doneAtMs: doneDate === 0 ? null : doneDate * 1000,
      lastActivityAtMs: activityDate === 0 ? null : activityDate * 1000,
      downloadDir: readString(row, "downloadDir", hashString),
      downloadedBytes: readNumber(row, "downloadedEver", hashString),
      uploadedBytes: readNumber(row, "uploadedEver", hashString),
      corruptBytes: readNumber(row, "corruptEver", hashString),
      haveValidBytes: readNumber(row, "haveValid", hashString),
      secondsDownloading: readNumber(row, "secondsDownloading", hashString),
      secondsSeeding: readNumber(row, "secondsSeeding", hashString),
      errorMessage: errorString === "" ? null : errorString,
    },
    files: files.map((rawFile, index) => {
      const file = requireNestedObject(rawFile, `files[${index}]`, hashString);
      const stats = requireNestedObject(
        fileStats[index],
        `fileStats[${index}]`,
        hashString,
      );
      const length = readNumber(file, "length", hashString);
      const completed = readNumber(stats, "bytesCompleted", hashString);
      return {
        name: readString(file, "name", hashString),
        lengthBytes: length,
        completedBytes: completed,
        wanted: readBoolean(stats, "wanted", hashString),
        priority: readNumber(stats, "priority", hashString),
        progress: length === 0 ? 0 : completed / length,
      };
    }),
    peers: peers.map((rawPeer, index) => {
      const peer = requireNestedObject(rawPeer, `peers[${index}]`, hashString);
      return {
        address: readString(peer, "address", hashString),
        port: readNumber(peer, "port", hashString),
        client: readString(peer, "clientName", hashString),
        flags: readString(peer, "flagStr", hashString),
        progress: readNumber(peer, "progress", hashString),
        rateToClient: readNumber(peer, "rateToClient", hashString),
        rateToPeer: readNumber(peer, "rateToPeer", hashString),
        isEncrypted: readBoolean(peer, "isEncrypted", hashString),
        isIncoming: readBoolean(peer, "isIncoming", hashString),
        isUtp: readBoolean(peer, "isUTP", hashString),
      };
    }),
    trackers: trackerStats.map((rawTracker, index) => {
      const tracker = requireNestedObject(
        rawTracker,
        `trackerStats[${index}]`,
        hashString,
      );
      const seederCount = readNumber(tracker, "seederCount", hashString);
      const leecherCount = readNumber(tracker, "leecherCount", hashString);
      const downloadCount = readNumber(tracker, "downloadCount", hashString);
      const lastAnnounceResult = readString(
        tracker,
        "lastAnnounceResult",
        hashString,
      );
      const nextAnnounceTime = readNumber(
        tracker,
        "nextAnnounceTime",
        hashString,
      );
      return {
        host: readString(tracker, "host", hashString),
        tier: readNumber(tracker, "tier", hashString),
        isBackup: readBoolean(tracker, "isBackup", hashString),
        // Transmission uses any negative scrape count as "unknown"; zero is a
        // real reported count and must remain distinguishable.
        seeders: seederCount < 0 ? null : seederCount,
        leechers: leecherCount < 0 ? null : leecherCount,
        downloads: downloadCount < 0 ? null : downloadCount,
        lastAnnounceSucceeded: readBoolean(
          tracker,
          "lastAnnounceSucceeded",
          hashString,
        ),
        lastAnnounceResult:
          lastAnnounceResult === "" ? null : lastAnnounceResult,
        nextAnnounceAtMs:
          nextAnnounceTime === 0 ? null : nextAnnounceTime * 1000,
      };
    }),
  };
}

/** Maps scoped torrent-get arguments to one detail row or null when unknown. */
export function normalizeTorrentDetailGetArguments(
  raw: unknown,
): TransmissionTorrentDetail | null {
  const args = requireObject(raw, "torrent detail arguments");
  const torrents = args.torrents;
  if (!Array.isArray(torrents)) {
    throw fieldError(
      "torrents",
      "torrent detail",
      "missing or wrong type",
    );
  }
  if (torrents.length === 0) {
    return null;
  }
  if (torrents.length !== 1) {
    throw fieldError(
      "torrents",
      "torrent detail",
      `expected one row, received ${torrents.length}`,
    );
  }
  return normalizeTorrentDetail(torrents[0]);
}

/**
 * Maps one torrent-get row into TransmissionTorrentView.
 *
 * @throws TransmissionUpstreamError (502) when a required field is missing or
 * the wrong type. The message names the field and the torrent hash.
 */
export function normalizeTorrent(raw: unknown): TransmissionTorrentView {
  const row = requireObject(raw, "torrent-get row");
  const hash = readOptionalString(row, "hashString") ?? "unknown";

  const hashString = readString(row, "hashString", hash);
  const name = readString(row, "name", hashString);
  const labels = readStringArray(row, "labels", hashString);
  const status = readNumber(row, "status", hashString);
  const isFinished = readBoolean(row, "isFinished", hashString);
  const isStalled = readBoolean(row, "isStalled", hashString);
  const percentDone = readNumber(row, "percentDone", hashString);
  const sizeWhenDone = readNumber(row, "sizeWhenDone", hashString);
  const leftUntilDone = readNumber(row, "leftUntilDone", hashString);
  const uploadedEver = readNumber(row, "uploadedEver", hashString);
  const uploadRatio = readNumber(row, "uploadRatio", hashString);
  const rateDownload = readNumber(row, "rateDownload", hashString);
  const rateUpload = readNumber(row, "rateUpload", hashString);
  const eta = readNumber(row, "eta", hashString);
  const peersConnected = readNumber(row, "peersConnected", hashString);
  const peersSendingToUs = readNumber(row, "peersSendingToUs", hashString);
  const peersGettingFromUs = readNumber(row, "peersGettingFromUs", hashString);
  const errorCode = readNumber(row, "error", hashString);
  const errorString = readString(row, "errorString", hashString);
  const addedDate = readNumber(row, "addedDate", hashString);
  const doneDate = readNumber(row, "doneDate", hashString);
  const queuePosition = readNumber(row, "queuePosition", hashString);
  const downloadDir = readString(row, "downloadDir", hashString);
  const recheckProgress = readNumber(row, "recheckProgress", hashString);
  const metadataPercentComplete = readNumber(
    row,
    "metadataPercentComplete",
    hashString,
  );

  return {
    hash: hashString,
    name,
    labels,
    state: stateFrom(status, isFinished, hashString),
    status,
    isStalled,
    progress: percentDone,
    sizeBytes: sizeWhenDone,
    downloadedBytes: sizeWhenDone - leftUntilDone,
    uploadedBytes: uploadedEver,
    ratio: uploadRatio,
    rateDownload,
    rateUpload,
    etaSeconds: eta < 0 ? null : eta,
    peers: {
      connected: peersConnected,
      sendingToUs: peersSendingToUs,
      gettingFromUs: peersGettingFromUs,
    },
    error:
      errorCode === 0 ? null : { code: errorCode, message: errorString },
    queuePosition,
    downloadDir,
    addedAtMs: addedDate * 1000,
    doneAtMs: doneDate === 0 ? null : doneDate * 1000,
    recheckProgress,
    metadataPercentComplete,
  };
}

/**
 * Maps a torrent-get `arguments` object into TransmissionTorrentView rows.
 * An empty torrents array is a valid answer meaning no torrents.
 *
 * @throws TransmissionUpstreamError (502) when `torrents` is missing or not
 * an array, or when any row fails normalizeTorrent.
 */
export function normalizeTorrentGetArguments(
  raw: unknown,
): TransmissionTorrentView[] {
  const args = requireObject(raw, "torrent-get arguments");
  const torrents = args.torrents;
  if (!Array.isArray(torrents)) {
    throw fieldError(
      "torrents",
      "torrent-get arguments",
      "missing or wrong type",
    );
  }
  return torrents.map((item) => normalizeTorrent(item));
}

/**
 * Maps a session-stats `arguments` object into the list-response aggregate.
 *
 * @throws TransmissionUpstreamError (502) when a required field is missing or
 * the wrong type. The message names the field.
 */
export function normalizeSessionStats(
  raw: unknown,
): TransmissionListResponse["session"] {
  const args = requireObject(raw, "session-stats arguments");
  return {
    torrentCount: readNumber(args, "torrentCount", "session-stats"),
    activeCount: readNumber(args, "activeTorrentCount", "session-stats"),
    pausedCount: readNumber(args, "pausedTorrentCount", "session-stats"),
    rateDownload: readNumber(args, "downloadSpeed", "session-stats"),
    rateUpload: readNumber(args, "uploadSpeed", "session-stats"),
  };
}

function stateFrom(
  status: number,
  isFinished: boolean,
  hash: string,
): TransmissionTorrentState {
  switch (status) {
    case 0:
      return isFinished ? "seeding-complete" : "stopped";
    case 1:
      return "check-wait";
    case 2:
      return "checking";
    case 3:
      return "download-wait";
    case 4:
      return "downloading";
    case 5:
      return "seed-wait";
    case 6:
      return "seeding";
    default:
      throw fieldError("status", hash, "unrecognised value");
  }
}

function requireObject(
  raw: unknown,
  what: string,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TransmissionUpstreamError(
      `Transmission ${what} was not an object`,
      502,
    );
  }
  return raw as Record<string, unknown>;
}

function readOptionalString(
  row: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = row[field];
  return typeof value === "string" ? value : undefined;
}

function readString(
  row: Record<string, unknown>,
  field: string,
  hash: string,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw fieldError(field, hash, "missing or wrong type");
  }
  return value;
}

function readNumber(
  row: Record<string, unknown>,
  field: string,
  hash: string,
): number {
  const value = row[field];
  if (typeof value !== "number") {
    throw fieldError(field, hash, "missing or wrong type");
  }
  return value;
}

function readBoolean(
  row: Record<string, unknown>,
  field: string,
  hash: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw fieldError(field, hash, "missing or wrong type");
  }
  return value;
}

function readArray(
  row: Record<string, unknown>,
  field: string,
  hash: string,
): unknown[] {
  const value = row[field];
  if (!Array.isArray(value)) {
    throw fieldError(field, hash, "missing or wrong type");
  }
  return value;
}

function requireNestedObject(
  value: unknown,
  field: string,
  hash: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fieldError(field, hash, "missing or wrong type");
  }
  return value as Record<string, unknown>;
}

function readStringArray(
  row: Record<string, unknown>,
  field: string,
  hash: string,
): string[] {
  const value = row[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw fieldError(field, hash, "missing or wrong type");
  }
  return value;
}

function fieldError(
  field: string,
  hash: string,
  detail: string,
): TransmissionUpstreamError {
  return new TransmissionUpstreamError(
    `Transmission field ${field} ${detail} (hash ${hash})`,
    502,
  );
}
