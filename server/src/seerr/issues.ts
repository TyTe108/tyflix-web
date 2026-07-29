// Parsing and code translation for Seerr issues, which is what backs the
// "report a problem" flow: bad audio, wrong cut, missing subtitles.
//
// Split out of seerr/client.ts so the numeric enums and the nested response
// parsing live in one place. The client owns the HTTP calls and imports the
// mapper; routes/issues.ts imports the types. Nothing in here does any I/O.
//
// Seerr sends issue type and status as integers. Everything above this file
// deals in the string labels only.

export type IssueType = "video" | "audio" | "subtitles" | "other";
export type IssueStatus = "open" | "resolved";

export type IssueCommentView = {
  id: number;
  message: string;
  createdAt: string;
  user: {
    id: number;
    displayName: string;
  };
};

// An issue as the browser sees it, codes already named. This is both the
// mapper's output and the API response body, so it goes out over the wire
// unchanged.
export type IssueView = {
  id: number;
  issueType: IssueType;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
  problemSeason: number | null; // null for movies or a whole-show report
  problemEpisode: number | null;
  media: {
    id: number; // Seerr media id
    tmdbId: number;
    mediaType: "movie" | "tv";
    // Seerr doesn't send these, so the mapper always writes null and
    // routes/issues.ts fills them in from TMDB before responding.
    title: string | null;
    posterUrl: string | null;
  };
  createdBy: {
    id: number; // compared against the session's Seerr user id for access control
    displayName: string;
    plexUsername: string;
  };
  comments: IssueCommentView[]; // empty when Seerr omits the thread
};

// Seerr's issue enums in both directions. Reading uses the code-to-label map,
// creating uses the reverse.
const ISSUE_TYPES = {
  1: "video",
  2: "audio",
  3: "subtitles",
  4: "other",
} as const;

const ISSUE_TYPE_CODES = {
  video: 1,
  audio: 2,
  subtitles: 3,
  other: 4,
} as const;

const ISSUE_STATUSES = {
  1: "open",
  2: "resolved",
} as const;

/**
 * @returns null for a code outside the table, which makes mapSeerrIssue drop
 * the row rather than invent a type for it.
 */
export function issueTypeFromCode(code: number): IssueType | null {
  return ISSUE_TYPES[code as keyof typeof ISSUE_TYPES] ?? null;
}

/** Direction used when filing an issue, since Seerr's POST body wants the code. */
export function issueTypeToCode(issueType: IssueType): number {
  return ISSUE_TYPE_CODES[issueType];
}

/** @returns null for an unrecognized code. Same drop-the-row rule as above. */
export function issueStatusFromCode(code: number): IssueStatus | null {
  return ISSUE_STATUSES[code as keyof typeof ISSUE_STATUSES] ?? null;
}

/**
 * Parses one Seerr issue object into an IssueView.
 *
 * Used two ways: over a list, where null means skip this row and keep going,
 * and on a single response, where the client turns null into a 502. Comments
 * are the one loose part, since an individual malformed comment is dropped but
 * a `comments` field that isn't an array rejects the whole issue.
 *
 * @returns null when anything required is missing or unrecognized.
 */
export function mapSeerrIssue(value: unknown): IssueView | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const row = value as Record<string, unknown>;
  const issueType =
    typeof row.issueType === "number"
      ? issueTypeFromCode(row.issueType)
      : null;
  const status =
    typeof row.status === "number" ? issueStatusFromCode(row.status) : null;
  if (
    !isFiniteNumber(row.id) ||
    issueType === null ||
    status === null ||
    typeof row.createdAt !== "string" ||
    typeof row.updatedAt !== "string" ||
    !isNullableNumber(row.problemSeason) ||
    !isNullableNumber(row.problemEpisode)
  ) {
    return null;
  }

  const media = mapMedia(row.media);
  const createdBy = mapCreatedBy(row.createdBy);
  if (media === null || createdBy === null) {
    return null;
  }

  // A missing comments field is tolerated and becomes an empty thread. A field
  // that's present but isn't an array means the shape changed under us, and
  // that row can't be trusted.
  const comments: IssueCommentView[] = [];
  if (row.comments !== undefined) {
    if (!Array.isArray(row.comments)) {
      return null;
    }
    for (const comment of row.comments) {
      const mapped = mapComment(comment);
      if (mapped !== null) {
        comments.push(mapped);
      }
    }
  }

  return {
    id: row.id,
    issueType,
    status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    problemSeason:
      typeof row.problemSeason === "number" ? row.problemSeason : null,
    problemEpisode:
      typeof row.problemEpisode === "number" ? row.problemEpisode : null,
    media,
    createdBy,
    comments,
  };
}

// The media an issue is filed against. Both ids matter: `id` is what Seerr's
// own API takes, `tmdbId` is what the enrichment step needs to fetch a title
// and poster. title and posterUrl start as null by design; see the type.
function mapMedia(value: unknown): IssueView["media"] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    !isFiniteNumber(row.id) ||
    !isFiniteNumber(row.tmdbId) ||
    (row.mediaType !== "movie" && row.mediaType !== "tv")
  ) {
    return null;
  }
  return {
    id: row.id,
    tmdbId: row.tmdbId,
    mediaType: row.mediaType,
    title: null,
    posterUrl: null,
  };
}

// The reporter. Required, not cosmetic: the issues router compares this id
// against the session to decide who's allowed to read or comment on a thread.
function mapCreatedBy(value: unknown): IssueView["createdBy"] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    !isFiniteNumber(row.id) ||
    typeof row.displayName !== "string" ||
    typeof row.plexUsername !== "string"
  ) {
    return null;
  }
  return {
    id: row.id,
    displayName: row.displayName,
    plexUsername: row.plexUsername,
  };
}

// One comment plus its author. A bad comment is skipped, so a single odd
// record can't hide the rest of a thread.
function mapComment(value: unknown): IssueCommentView | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    !isFiniteNumber(row.id) ||
    typeof row.message !== "string" ||
    typeof row.createdAt !== "string" ||
    typeof row.user !== "object" ||
    row.user === null
  ) {
    return null;
  }
  const user = row.user as Record<string, unknown>;
  if (!isFiniteNumber(user.id) || typeof user.displayName !== "string") {
    return null;
  }
  return {
    id: row.id,
    message: row.message,
    createdAt: row.createdAt,
    user: {
      id: user.id,
      displayName: user.displayName,
    },
  };
}

// Narrows to a real number, so NaN and Infinity fail the same way a string does.
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// For the optional season and episode fields, where absent and null both mean
// "not specified".
function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || isFiniteNumber(value);
}
