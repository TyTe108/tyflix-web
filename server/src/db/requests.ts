import { getDb } from "./index";

export type MediaType = "movie" | "tv";

export type RequestApprovalStatus =
  | "pending"
  | "approved"
  | "declined"
  | "failed";

export type MediaAvailabilityStatus =
  | "unknown"
  | "pending"
  | "processing"
  | "partially_available"
  | "available";

export type RequestRow = {
  id: number;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  seasons: number[] | null;
  requestedBySeerrId: number;
  requestedByName: string;
  requestStatus: RequestApprovalStatus;
  mediaStatus: MediaAvailabilityStatus;
  radarrId: number | null;
  sonarrId: number | null;
  createdAt: string;
  updatedAt: string;
  decidedBy: number | null;
  decidedAt: string | null;
};

export type CreateRequestInput = {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  seasons?: number[] | null;
  requestedBySeerrId: number;
  requestedByName: string;
  requestStatus?: RequestApprovalStatus;
  mediaStatus?: MediaAvailabilityStatus;
};

export type UpdateRequestPatch = {
  requestStatus?: RequestApprovalStatus;
  mediaStatus?: MediaAvailabilityStatus;
  radarrId?: number | null;
  sonarrId?: number | null;
  decidedBy?: number | null;
  decidedAt?: string | null;
};

type RequestDbRow = {
  id: number;
  tmdb_id: number;
  media_type: MediaType;
  title: string;
  seasons: string | null;
  requested_by_seerr_id: number;
  requested_by_name: string;
  request_status: RequestApprovalStatus;
  media_status: MediaAvailabilityStatus;
  radarr_id: number | null;
  sonarr_id: number | null;
  created_at: string;
  updated_at: string;
  decided_by: number | null;
  decided_at: string | null;
};

function serializeSeasons(seasons: number[] | null | undefined): string | null {
  if (seasons === undefined || seasons === null) {
    return null;
  }
  return JSON.stringify(seasons);
}

function parseSeasons(raw: string | null): number[] | null {
  if (raw === null) {
    return null;
  }
  return JSON.parse(raw) as number[];
}

function mapRow(row: RequestDbRow): RequestRow {
  return {
    id: row.id,
    tmdbId: row.tmdb_id,
    mediaType: row.media_type,
    title: row.title,
    seasons: parseSeasons(row.seasons),
    requestedBySeerrId: row.requested_by_seerr_id,
    requestedByName: row.requested_by_name,
    requestStatus: row.request_status,
    mediaStatus: row.media_status,
    radarrId: row.radarr_id,
    sonarrId: row.sonarr_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

const SELECT_COLUMNS = `
  id, tmdb_id, media_type, title, seasons,
  requested_by_seerr_id, requested_by_name, request_status, media_status,
  radarr_id, sonarr_id, created_at, updated_at,
  decided_by, decided_at
`;

export function createRequest(input: CreateRequestInput): RequestRow {
  const db = getDb();
  const now = new Date().toISOString();
  const requestStatus = input.requestStatus ?? "pending";
  const mediaStatus = input.mediaStatus ?? "unknown";

  const result = db
    .prepare(
      `INSERT INTO requests (
        tmdb_id, media_type, title, seasons,
        requested_by_seerr_id, requested_by_name, request_status, media_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.tmdbId,
      input.mediaType,
      input.title,
      serializeSeasons(input.seasons),
      input.requestedBySeerrId,
      input.requestedByName,
      requestStatus,
      mediaStatus,
      now,
      now,
    );

  const created = getRequestById(Number(result.lastInsertRowid));
  if (created === null) {
    throw new Error("Failed to read back created request");
  }
  return created;
}

export function getRequestById(id: number): RequestRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM requests WHERE id = ?`)
    .get(id) as RequestDbRow | undefined;
  return row === undefined ? null : mapRow(row);
}

export function listRequestsByUser(seerrUserId: number): RequestRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM requests
       WHERE requested_by_seerr_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(seerrUserId) as RequestDbRow[];
  return rows.map(mapRow);
}

export function listAllRequests(): RequestRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM requests
       ORDER BY created_at DESC, id DESC`,
    )
    .all() as RequestDbRow[];
  return rows.map(mapRow);
}

export function findActiveDuplicate(
  tmdbId: number,
  mediaType: MediaType,
): RequestRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM requests
       WHERE tmdb_id = ? AND media_type = ?
         AND request_status NOT IN ('declined', 'failed')
       LIMIT 1`,
    )
    .get(tmdbId, mediaType) as RequestDbRow | undefined;
  return row === undefined ? null : mapRow(row);
}

export function updateRequest(
  id: number,
  patch: UpdateRequestPatch,
): RequestRow {
  const db = getDb();
  const existing = getRequestById(id);
  if (existing === null) {
    throw new Error(`Request not found: ${id}`);
  }

  const updatedAt = new Date().toISOString();
  const requestStatus = patch.requestStatus ?? existing.requestStatus;
  const mediaStatus = patch.mediaStatus ?? existing.mediaStatus;
  const radarrId =
    patch.radarrId !== undefined ? patch.radarrId : existing.radarrId;
  const sonarrId =
    patch.sonarrId !== undefined ? patch.sonarrId : existing.sonarrId;
  const decidedBy =
    patch.decidedBy !== undefined ? patch.decidedBy : existing.decidedBy;
  const decidedAt =
    patch.decidedAt !== undefined ? patch.decidedAt : existing.decidedAt;

  db.prepare(
    `UPDATE requests SET
      request_status = ?,
      media_status = ?,
      radarr_id = ?,
      sonarr_id = ?,
      decided_by = ?,
      decided_at = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    requestStatus,
    mediaStatus,
    radarrId,
    sonarrId,
    decidedBy,
    decidedAt,
    updatedAt,
    id,
  );

  const updated = getRequestById(id);
  if (updated === null) {
    throw new Error(`Failed to read back updated request: ${id}`);
  }
  return updated;
}
