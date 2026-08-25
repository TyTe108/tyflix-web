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
