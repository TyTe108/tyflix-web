import {
  issueTypeToCode,
  mapSeerrIssue,
  type IssueStatus,
  type IssueType,
  type IssueView,
} from "./issues";

export type SeerrUser = {
  id: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  email: string | null;
  permissions: number;
};

export type SeerrMedia = {
  tmdbId: number;
  tvdbId: number | null;
  status: number;
  ratingKey: string | number | null;
  mediaType: string | null;
};

export type MediaAvailability =
  | "unknown"
  | "pending"
  | "processing"
  | "partially_available"
  | "available"
  | "blocklisted"
  | "deleted";

export type SeerrMediaListItem = {
  id: number;
  tmdbId: number;
  mediaType: "movie" | "tv";
  status: number;
};

export type SeerrWatchlistItem = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
};

export type QuotaAxis = {
  days: number;
  limit: number;
  used: number;
  restricted: boolean;
};

export type UserQuota = {
  movie: QuotaAxis;
  tv: QuotaAxis;
};

export type SeerrRequestSeason = {
  seasonNumber: number;
};

export type SeerrRequest = {
  id: number;
  status: number;
  type: "movie" | "tv";
  media: SeerrMedia;
  seasons: SeerrRequestSeason[];
  createdAt: string;
  requestedBy: {
    id: number;
    displayName: string;
    plexUsername: string;
  };
};

export type RequestView = {
  id: number;
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  seasons: number[];
  requestStatus:
    | "pending"
    | "approved"
    | "declined"
    | "failed"
    | "completed";
  mediaStatus: MediaAvailability;
  requestedById: number;
  requestedByName: string;
  createdAt: string;
};

export type CreateSeerrRequestInput = {
  mediaType: "movie" | "tv";
  tmdbId: number;
  seasons?: number[];
  userId: number;
  profileId?: number;
  serverId?: number;
};

export type ServiceProfiles = {
  serverId: number;
  defaultProfileId: number;
  profiles: Array<{ id: number; name: string }>;
};

export type CreateSeerrIssueInput = {
  issueType: IssueType;
  message: string;
  mediaId: number;
  userId: number;
  problemSeason?: number;
  problemEpisode?: number;
};

export class SeerrUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SeerrUpstreamError";
    this.status = status;
  }
}

export type SeerrClientOptions = {
  baseUrl: string;
  apiKey: string;
};

export function createSeerrClient(options: SeerrClientOptions) {
  const { baseUrl, apiKey } = options;

  async function requestJson(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": apiKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Seerr request failed";
      throw new SeerrUpstreamError(message, 502);
    }

    if (!res.ok) {
      throw new SeerrUpstreamError(
        `Seerr ${path} failed (${res.status})`,
        res.status,
      );
    }

    return res.json();
  }

  function getJson(
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    return requestJson("GET", path, query);
  }

  function postJson(path: string, body?: unknown): Promise<unknown> {
    return requestJson("POST", path, {}, body);
  }

  async function getUserByPlexId(plexId: number): Promise<SeerrUser | null> {
    const take = 100;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;

    while (skip < total) {
      const body = await getJson("/api/v1/user", {
        take: String(take),
        skip: String(skip),
      });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          "Seerr getUserByPlexId returned unexpected body",
          502,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          "Seerr getUserByPlexId returned unexpected pageInfo",
          502,
        );
      }

      total = pageInfo.results;
      const results = (body as { results: unknown[] }).results;

      for (const row of results) {
        const mapped = mapSeerrUser(row);
        if (mapped !== null && mapped.plexId === plexId) {
          return mapped;
        }
      }

      if (results.length === 0) {
        break;
      }
      skip += take;
    }

    return null;
  }

  async function listRequests(
    path: string,
    query: Record<string, string> = {},
  ): Promise<SeerrRequest[]> {
    const take = 100;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    const requests: SeerrRequest[] = [];

    while (skip < total) {
      const body = await getJson(path, {
        take: String(take),
        skip: String(skip),
        ...query,
      });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          `Seerr ${path} returned unexpected body`,
          502,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          `Seerr ${path} returned unexpected pageInfo`,
          502,
        );
      }

      total = pageInfo.results;
      const results = (body as { results: unknown[] }).results;

      for (const row of results) {
        const mapped = mapSeerrRequest(row);
        if (mapped === null) {
          // One malformed request must not fail the whole list.
          console.warn(`Seerr ${path} returned an unmappable request; skipping`);
          continue;
        }
        requests.push(mapped);
      }

      if (results.length === 0) {
        break;
      }
      skip += take;
    }

    return requests;
  }

  function listAllRequests(): Promise<SeerrRequest[]> {
    return listRequests("/api/v1/request", { sort: "added" });
  }

  function listUserRequests(userId: number): Promise<SeerrRequest[]> {
    return listRequests(`/api/v1/user/${userId}/requests`);
  }

  async function getUserQuota(userId: number): Promise<UserQuota> {
    const body = await getJson(`/api/v1/user/${userId}/quota`);
    if (typeof body !== "object" || body === null) {
      throw new SeerrUpstreamError(
        "Seerr getUserQuota returned unexpected body",
        502,
      );
    }

    const movie = mapQuotaAxis((body as { movie?: unknown }).movie);
    const tv = mapQuotaAxis((body as { tv?: unknown }).tv);
    if (movie === null || tv === null) {
      throw new SeerrUpstreamError(
        "Seerr getUserQuota returned unexpected body",
        502,
      );
    }

    return { movie, tv };
  }

  async function getServiceProfiles(
    mediaType: "movie" | "tv",
  ): Promise<ServiceProfiles> {
    const service = mediaType === "movie" ? "radarr" : "sonarr";
    const serversBody = await getJson(`/api/v1/service/${service}`);
    if (!Array.isArray(serversBody) || serversBody.length === 0) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected server list",
        502,
      );
    }

    const servers = serversBody.map(mapServiceServer);
    if (servers.some((server) => server === null)) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected server list",
        502,
      );
    }
    const validServers = servers as Array<{ id: number; isDefault: boolean }>;
    const selected =
      validServers.find((server) => server.isDefault) ?? validServers[0];

    const detailBody = await getJson(
      `/api/v1/service/${service}/${selected.id}`,
    );
    if (typeof detailBody !== "object" || detailBody === null) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected service detail",
        502,
      );
    }

    const server = (detailBody as { server?: unknown }).server;
    const profilesBody = (detailBody as { profiles?: unknown }).profiles;
    if (
      typeof server !== "object" ||
      server === null ||
      !Array.isArray(profilesBody)
    ) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected service detail",
        502,
      );
    }

    const defaultProfileId = (server as { activeProfileId?: unknown })
      .activeProfileId;
    const profiles = profilesBody.map(mapServiceProfile);
    if (
      typeof defaultProfileId !== "number" ||
      !Number.isFinite(defaultProfileId) ||
      profiles.some((profile) => profile === null)
    ) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected service detail",
        502,
      );
    }

    return {
      serverId: selected.id,
      defaultProfileId,
      profiles: profiles as Array<{ id: number; name: string }>,
    };
  }

  async function listMedia(): Promise<SeerrMediaListItem[]> {
    const take = 100;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    const media: SeerrMediaListItem[] = [];

    while (skip < total) {
      const body = await getJson("/api/v1/media", {
        take: String(take),
        skip: String(skip),
      });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          "Seerr /api/v1/media returned unexpected body",
          502,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          "Seerr /api/v1/media returned unexpected pageInfo",
          502,
        );
      }

      total = pageInfo.results;
      const results = (body as { results: unknown[] }).results;
      for (const row of results) {
        const mapped = mapSeerrMediaListItem(row);
        if (mapped !== null) {
          media.push(mapped);
        }
      }

      if (results.length === 0) {
        break;
      }
      skip += take;
    }

    return media;
  }

  async function listUserWatchlist(
    userId: number,
    page = 1,
  ): Promise<SeerrWatchlistItem[]> {
    let currentPage = page;
    let totalPages = currentPage;
    const watchlist: SeerrWatchlistItem[] = [];

    do {
      const path = `/api/v1/user/${userId}/watchlist`;
      const body = await getJson(path, { page: String(currentPage) });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { totalPages?: unknown }).totalPages !== "number" ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          `Seerr ${path} returned unexpected body`,
          502,
        );
      }

      totalPages = (body as { totalPages: number }).totalPages;
      const results = (body as { results: unknown[] }).results;
      for (const row of results) {
        const mapped = mapSeerrWatchlistItem(row);
        if (mapped !== null) {
          watchlist.push(mapped);
        }
      }
      currentPage += 1;
    } while (currentPage <= totalPages);

    return watchlist;
  }

  async function listIssues(): Promise<IssueView[]> {
    const take = 100;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    const issues: IssueView[] = [];

    while (skip < total) {
      const body = await getJson("/api/v1/issue", {
        take: String(take),
        skip: String(skip),
        sort: "added",
        filter: "all",
      });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          "Seerr /api/v1/issue returned unexpected body",
          502,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          "Seerr /api/v1/issue returned unexpected pageInfo",
          502,
        );
      }

      total = pageInfo.results;
      const results = (body as { results: unknown[] }).results;
      for (const row of results) {
        const mapped = mapSeerrIssue(row);
        if (mapped !== null) {
          issues.push(mapped);
        }
      }

      if (results.length === 0) {
        break;
      }
      skip += take;
    }

    return issues;
  }

  async function getIssue(id: number): Promise<IssueView> {
    const body = await getJson(`/api/v1/issue/${id}`);
    return requireSeerrIssue(body, "getIssue");
  }

  async function createIssue(
    input: CreateSeerrIssueInput,
  ): Promise<IssueView> {
    const body = await postJson("/api/v1/issue", {
      issueType: issueTypeToCode(input.issueType),
      message: input.message,
      mediaId: input.mediaId,
      userId: input.userId,
      ...(input.problemSeason === undefined
        ? {}
        : { problemSeason: input.problemSeason }),
      ...(input.problemEpisode === undefined
        ? {}
        : { problemEpisode: input.problemEpisode }),
    });
    return requireSeerrIssue(body, "createIssue");
  }

  async function addIssueComment(
    issueId: number,
    message: string,
  ): Promise<IssueView> {
    const body = await postJson(`/api/v1/issue/${issueId}/comment`, {
      message,
    });
    return requireSeerrIssue(body, "addIssueComment");
  }

  async function setIssueStatus(
    issueId: number,
    status: IssueStatus,
  ): Promise<IssueView> {
    const body = await postJson(`/api/v1/issue/${issueId}/${status}`);
    return requireSeerrIssue(body, "setIssueStatus");
  }

  async function createRequest(
    input: CreateSeerrRequestInput,
  ): Promise<SeerrRequest> {
    const body = await postJson("/api/v1/request", {
      mediaType: input.mediaType,
      mediaId: input.tmdbId,
      ...(input.mediaType === "tv" && input.seasons !== undefined
        ? { seasons: input.seasons }
        : {}),
      userId: input.userId,
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
    });
    return requireSeerrRequest(body, "createRequest");
  }

  async function approveRequest(id: number): Promise<SeerrRequest> {
    const body = await postJson(`/api/v1/request/${id}/approve`);
    return requireSeerrRequest(body, "approveRequest");
  }

  async function declineRequest(id: number): Promise<SeerrRequest> {
    const body = await postJson(`/api/v1/request/${id}/decline`);
    return requireSeerrRequest(body, "declineRequest");
  }

  return {
    getUserByPlexId,
    listAllRequests,
    listUserRequests,
    getRequestsByUser: listUserRequests,
    getUserQuota,
    getServiceProfiles,
    listMedia,
    listUserWatchlist,
    listIssues,
    getIssue,
    createIssue,
    addIssueComment,
    setIssueStatus,
    createRequest,
    approveRequest,
    declineRequest,
  };
}

export type SeerrClient = ReturnType<typeof createSeerrClient>;

const REQUEST_STATUS = {
  1: "pending",
  2: "approved",
  3: "declined",
  4: "failed",
  5: "completed",
} as const;

const MEDIA_STATUS = {
  1: "unknown",
  2: "pending",
  3: "processing",
  4: "partially_available",
  5: "available",
  6: "blocklisted",
  7: "deleted",
} as const;

export function mediaStatusFromCode(code: number): MediaAvailability | null {
  return MEDIA_STATUS[code as keyof typeof MEDIA_STATUS] ?? null;
}

export function toRequestView(req: SeerrRequest, title: string): RequestView {
  const requestStatus = REQUEST_STATUS[req.status as keyof typeof REQUEST_STATUS];
  const mediaStatus = mediaStatusFromCode(req.media.status);
  if (requestStatus === undefined || mediaStatus === null) {
    throw new SeerrUpstreamError("Seerr request returned an unknown status", 502);
  }

  return {
    id: req.id,
    tmdbId: req.media.tmdbId,
    mediaType: req.type,
    title,
    seasons: req.seasons.map((season) => season.seasonNumber),
    requestStatus,
    mediaStatus,
    requestedById: req.requestedBy.id,
    requestedByName:
      req.requestedBy.displayName || req.requestedBy.plexUsername,
    createdAt: req.createdAt,
  };
}

function mapSeerrMediaListItem(row: unknown): SeerrMediaListItem | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  const tmdbId = (row as { tmdbId?: unknown }).tmdbId;
  const mediaType = (row as { mediaType?: unknown }).mediaType;
  const status = (row as { status?: unknown }).status;
  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    typeof tmdbId !== "number" ||
    !Number.isFinite(tmdbId) ||
    (mediaType !== "movie" && mediaType !== "tv") ||
    typeof status !== "number" ||
    !Number.isFinite(status)
  ) {
    return null;
  }

  return { id, tmdbId, mediaType, status };
}

function mapSeerrWatchlistItem(row: unknown): SeerrWatchlistItem | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const tmdbId = (row as { tmdbId?: unknown }).tmdbId;
  const mediaType = (row as { mediaType?: unknown }).mediaType;
  const title = (row as { title?: unknown }).title;
  if (
    typeof tmdbId !== "number" ||
    !Number.isFinite(tmdbId) ||
    (mediaType !== "movie" && mediaType !== "tv") ||
    typeof title !== "string"
  ) {
    return null;
  }

  return { tmdbId, mediaType, title };
}

function mapQuotaAxis(row: unknown): QuotaAxis | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const days = (row as { days?: unknown }).days;
  const limit = (row as { limit?: unknown }).limit;
  const used = (row as { used?: unknown }).used;
  const restricted = (row as { restricted?: unknown }).restricted;
  if (
    typeof days !== "number" ||
    !Number.isFinite(days) ||
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    typeof restricted !== "boolean"
  ) {
    return null;
  }

  return { days, limit, used, restricted };
}

function mapServiceServer(
  row: unknown,
): { id: number; isDefault: boolean } | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const id = (row as { id?: unknown }).id;
  const isDefault = (row as { isDefault?: unknown }).isDefault;
  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    typeof isDefault !== "boolean"
  ) {
    return null;
  }
  return { id, isDefault };
}

function mapServiceProfile(
  row: unknown,
): { id: number; name: string } | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const id = (row as { id?: unknown }).id;
  const name = (row as { name?: unknown }).name;
  if (typeof id !== "number" || !Number.isFinite(id) || typeof name !== "string") {
    return null;
  }
  return { id, name };
}

function mapSeerrUser(row: unknown): SeerrUser | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  const plexId = (row as { plexId?: unknown }).plexId;
  const plexUsername = (row as { plexUsername?: unknown }).plexUsername;
  const displayName = (row as { displayName?: unknown }).displayName;
  const email = (row as { email?: unknown }).email;
  const permissions = (row as { permissions?: unknown }).permissions;

  if (
    typeof id !== "number" ||
    typeof plexId !== "number" ||
    typeof plexUsername !== "string" ||
    typeof displayName !== "string" ||
    typeof permissions !== "number"
  ) {
    return null;
  }

  return {
    id,
    plexId,
    plexUsername,
    displayName,
    email: typeof email === "string" ? email : null,
    permissions,
  };
}

function mapSeerrRequest(row: unknown): SeerrRequest | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  const requestStatus = (row as { status?: unknown }).status;
  const type = (row as { type?: unknown }).type;
  const createdAt = (row as { createdAt?: unknown }).createdAt;
  const mediaRaw = (row as { media?: unknown }).media;
  const requestedByRaw = (row as { requestedBy?: unknown }).requestedBy;
  const seasonsRaw = (row as { seasons?: unknown }).seasons;

  if (
    typeof id !== "number" ||
    typeof requestStatus !== "number" ||
    (type !== "movie" && type !== "tv")
  ) {
    return null;
  }
  if (typeof createdAt !== "string") {
    return null;
  }
  if (typeof mediaRaw !== "object" || mediaRaw === null) {
    return null;
  }
  if (typeof requestedByRaw !== "object" || requestedByRaw === null) {
    return null;
  }

  const requestedById = (requestedByRaw as { id?: unknown }).id;
  const displayName = (requestedByRaw as { displayName?: unknown }).displayName;
  const plexUsername = (requestedByRaw as { plexUsername?: unknown }).plexUsername;
  if (
    typeof requestedById !== "number" ||
    typeof displayName !== "string" ||
    typeof plexUsername !== "string"
  ) {
    return null;
  }

  const mediaStatus = (mediaRaw as { status?: unknown }).status;
  const tmdbId = (mediaRaw as { tmdbId?: unknown }).tmdbId;
  const tvdbIdRaw = (mediaRaw as { tvdbId?: unknown }).tvdbId;
  if (
    typeof mediaStatus !== "number" ||
    typeof tmdbId !== "number" ||
    (typeof tvdbIdRaw !== "number" &&
      tvdbIdRaw !== null &&
      tvdbIdRaw !== undefined)
  ) {
    return null;
  }

  const ratingKeyRaw = (mediaRaw as { ratingKey?: unknown }).ratingKey;
  let ratingKey: string | number | null = null;
  if (typeof ratingKeyRaw === "string" || typeof ratingKeyRaw === "number") {
    ratingKey = ratingKeyRaw;
  } else if (ratingKeyRaw === null || ratingKeyRaw === undefined) {
    ratingKey = null;
  } else {
    return null;
  }

  const mediaTypeRaw = (mediaRaw as { mediaType?: unknown }).mediaType;
  const mediaType = typeof mediaTypeRaw === "string" ? mediaTypeRaw : null;

  const seasons: SeerrRequestSeason[] = [];
  if (Array.isArray(seasonsRaw)) {
    for (const season of seasonsRaw) {
      if (typeof season !== "object" || season === null) {
        continue;
      }
      const seasonNumber = (season as { seasonNumber?: unknown }).seasonNumber;
      if (typeof seasonNumber === "number") {
        seasons.push({ seasonNumber });
      }
    }
  }

  return {
    id,
    status: requestStatus,
    type,
    createdAt,
    media: {
      tmdbId,
      tvdbId: typeof tvdbIdRaw === "number" ? tvdbIdRaw : null,
      status: mediaStatus,
      ratingKey,
      mediaType,
    },
    seasons,
    requestedBy: {
      id: requestedById,
      displayName,
      plexUsername,
    },
  };
}

function requireSeerrRequest(body: unknown, operation: string): SeerrRequest {
  const request = mapSeerrRequest(body);
  if (request === null) {
    throw new SeerrUpstreamError(
      `Seerr ${operation} returned unexpected body`,
      502,
    );
  }
  return request;
}

function requireSeerrIssue(body: unknown, operation: string): IssueView {
  const issue = mapSeerrIssue(body);
  if (issue === null) {
    throw new SeerrUpstreamError(
      `Seerr ${operation} returned unexpected body`,
      502,
    );
  }
  return issue;
}
