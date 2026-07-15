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
  tmdbId: number;
  mediaType: "movie" | "tv";
  status: number;
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
    listMedia,
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

  const tmdbId = (row as { tmdbId?: unknown }).tmdbId;
  const mediaType = (row as { mediaType?: unknown }).mediaType;
  const status = (row as { status?: unknown }).status;
  if (
    typeof tmdbId !== "number" ||
    !Number.isFinite(tmdbId) ||
    (mediaType !== "movie" && mediaType !== "tv") ||
    typeof status !== "number" ||
    !Number.isFinite(status)
  ) {
    return null;
  }

  return { tmdbId, mediaType, status };
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
