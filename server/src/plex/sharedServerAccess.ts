// Resolves each shared/invited Plex user's per-server access token — distinct
// from their general plex.tv account token. Our PMS only accepts the
// per-server token for non-owners; the owner is never in this list, so
// resolveAccessToken returns null for them and callers fall back to the
// session's durable token. Uses the OWNER token (config.plexToken) against
// /identity and plex.tv's shared_servers endpoint.

export class PlexSharedServerAccessError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "PlexSharedServerAccessError";
    this.status = status;
  }
}

export type SharedServerAccessResolverOptions = {
  // LAN URL of our PMS, e.g. http://10.0.0.10:32400 (config.plexBaseUrl).
  baseUrl: string;
  // Owner/server token used against both /identity and plex.tv (config.plexToken).
  ownerToken: string;
  // X-Plex-Client-Identifier (config.plexClientId).
  clientId: string;
};

// Shares are added/revoked rarely, so cache the plexId → accessToken map
// briefly to avoid re-hitting plex.tv on every play decision.
const CACHE_TTL_MS = 10 * 60 * 1000;

export function createSharedServerAccessResolver(
  options: SharedServerAccessResolverOptions,
) {
  const { baseUrl, ownerToken, clientId } = options;
  let cache: { value: Map<number, string>; expiresAt: number } | null = null;

  // Returns the per-server access token for plexId, or null when that id is
  // not a shared user of this server (the normal owner case). Throws
  // PlexSharedServerAccessError on upstream failure — never silently empty.
  async function resolveAccessToken(plexId: number): Promise<string | null> {
    const map = await loadAccessMap();
    return map.get(plexId) ?? null;
  }

  async function loadAccessMap(): Promise<Map<number, string>> {
    const now = Date.now();
    if (cache !== null && cache.expiresAt > now) {
      return cache.value;
    }

    const machineIdentifier = await fetchMachineIdentifier();
    const value = await fetchSharedServerAccess(machineIdentifier);

    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  }

  async function fetchMachineIdentifier(): Promise<string> {
    const body = await getJson(`${baseUrl}/identity`, {
      "X-Plex-Token": ownerToken,
      Accept: "application/json",
    });

    const container =
      typeof body === "object" && body !== null
        ? (body as { MediaContainer?: unknown }).MediaContainer
        : null;
    const machineIdentifier =
      typeof container === "object" && container !== null
        ? (container as { machineIdentifier?: unknown }).machineIdentifier
        : undefined;

    if (typeof machineIdentifier !== "string" || machineIdentifier === "") {
      throw new PlexSharedServerAccessError(
        "Plex /identity returned no machineIdentifier",
      );
    }

    return machineIdentifier;
  }

  async function fetchSharedServerAccess(
    machineIdentifier: string,
  ): Promise<Map<number, string>> {
    const url =
      `https://plex.tv/api/servers/${machineIdentifier}/shared_servers` +
      `?X-Plex-Token=${encodeURIComponent(ownerToken)}`;

    const body = await getText(url, {
      "X-Plex-Client-Identifier": clientId,
    });

    return parseSharedServerAccess(body);
  }

  async function getJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Plex shared-server access request failed";
      throw new PlexSharedServerAccessError(message);
    }

    if (!res.ok) {
      throw new PlexSharedServerAccessError(
        `Plex request ${url} failed (${res.status})`,
      );
    }

    return res.json();
  }

  async function getText(
    url: string,
    headers: Record<string, string>,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Plex shared-server access request failed";
      throw new PlexSharedServerAccessError(message);
    }

    if (!res.ok) {
      throw new PlexSharedServerAccessError(
        `Plex request ${url} failed (${res.status})`,
      );
    }

    return res.text();
  }

  return { resolveAccessToken };
}

export type SharedServerAccessResolver = ReturnType<
  typeof createSharedServerAccessResolver
>;

// shared_servers always returns XML regardless of Accept. Match each
// <SharedServer ...> opening tag and pull userID + accessToken attributes;
// skip tags missing either rather than failing the whole parse.
function parseSharedServerAccess(xml: string): Map<number, string> {
  const map = new Map<number, string>();
  const tags = xml.match(/<SharedServer\b[^>]*>/g) ?? [];

  for (const tag of tags) {
    const userID = tag.match(/userID="(\d+)"/)?.[1];
    const accessToken = tag.match(/accessToken="([^"]+)"/)?.[1];
    if (userID === undefined || accessToken === undefined) {
      continue;
    }
    map.set(Number(userID), accessToken);
  }

  return map;
}
