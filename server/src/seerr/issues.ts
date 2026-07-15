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

export type IssueView = {
  id: number;
  issueType: IssueType;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
  problemSeason: number | null;
  problemEpisode: number | null;
  media: {
    id: number;
    tmdbId: number;
    mediaType: "movie" | "tv";
  };
  createdBy: {
    id: number;
    displayName: string;
    plexUsername: string;
  };
  comments: IssueCommentView[];
};

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

export function issueTypeFromCode(code: number): IssueType | null {
  return ISSUE_TYPES[code as keyof typeof ISSUE_TYPES] ?? null;
}

export function issueTypeToCode(issueType: IssueType): number {
  return ISSUE_TYPE_CODES[issueType];
}

export function issueStatusFromCode(code: number): IssueStatus | null {
  return ISSUE_STATUSES[code as keyof typeof ISSUE_STATUSES] ?? null;
}

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
  };
}

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || isFiniteNumber(value);
}
