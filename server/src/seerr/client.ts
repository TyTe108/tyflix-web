export type SeerrUser = {
  id: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  email: string | null;
  permissions: number;
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

  async function getUserByPlexId(plexId: number): Promise<SeerrUser | null> {
    const take = 100;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;

    while (skip < total) {
      const url = new URL(`${baseUrl}/api/v1/user`);
      url.searchParams.set("take", String(take));
      url.searchParams.set("skip", String(skip));

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
          `Seerr getUserByPlexId failed (${res.status})`,
          res.status,
        );
      }

      const body: unknown = await res.json();
      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          "Seerr getUserByPlexId returned unexpected body",
          res.status,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          "Seerr getUserByPlexId returned unexpected pageInfo",
          res.status,
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

  return { getUserByPlexId };
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
