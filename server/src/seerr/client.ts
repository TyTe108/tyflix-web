export type SeerrUser = {
  id: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  email: string | null;
  permissions: number;
};

export type SeerrMedia = {
  status: number;
  ratingKey: string | number | null;
  mediaType: string | null;
};

export type SeerrRequestSeason = {
  seasonNumber: number | null;
};

export type SeerrRequest = {
  type: "movie" | "tv";
  media: SeerrMedia;
  seasons: SeerrRequestSeason[];
  createdAt: string;
  requestedBy: { id: number };
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

  async function getJson(
    path: string,
    query: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Api-Key": apiKey,
          Accept: "application/json",
        },
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

  async function getRequestsByUser(
    seerrUserId: number,
  ): Promise<SeerrRequest[]> {
    const take = 100;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    const matched: SeerrRequest[] = [];

    while (skip < total) {
      const body = await getJson("/api/v1/request", {
        take: String(take),
        skip: String(skip),
        filter: "all",
        sort: "added",
      });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          "Seerr getRequestsByUser returned unexpected body",
          502,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          "Seerr getRequestsByUser returned unexpected pageInfo",
          502,
        );
      }

      total = pageInfo.results;
      const results = (body as { results: unknown[] }).results;

      for (const row of results) {
        const mapped = mapSeerrRequest(row);
        if (mapped !== null && mapped.requestedBy.id === seerrUserId) {
          matched.push(mapped);
        }
      }

      if (results.length === 0) {
        break;
      }
      skip += take;
    }

    return matched;
  }

  return { getUserByPlexId, getRequestsByUser };
}

export type SeerrClient = ReturnType<typeof createSeerrClient>;

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

  const type = (row as { type?: unknown }).type;
  const createdAt = (row as { createdAt?: unknown }).createdAt;
  const mediaRaw = (row as { media?: unknown }).media;
  const requestedByRaw = (row as { requestedBy?: unknown }).requestedBy;
  const seasonsRaw = (row as { seasons?: unknown }).seasons;

  if (type !== "movie" && type !== "tv") {
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
  if (typeof requestedById !== "number") {
    return null;
  }

  const status = (mediaRaw as { status?: unknown }).status;
  if (typeof status !== "number") {
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
      } else if (seasonNumber === null || seasonNumber === undefined) {
        seasons.push({ seasonNumber: null });
      }
    }
  }

  return {
    type,
    createdAt,
    media: {
      status,
      ratingKey,
      mediaType,
    },
    seasons,
    requestedBy: { id: requestedById },
  };
}
