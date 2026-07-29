// Resolves each shared/invited Plex user's per-server access token — distinct
// from their general plex.tv account token. Our PMS only accepts the
// per-server token for non-owners; the owner is never in this list, so
// resolveAccessToken returns null for them and callers fall back to the
// session's durable token. Uses the OWNER token (config.plexToken) against
// /identity and plex.tv's shared_servers endpoint.
//
// The failure this prevents isn't obvious. Send a shared user's general token
// and plex.tv is perfectly happy with it, then the media server refuses it.
// That's how one wrong token locked out every shared account at once while the
// owner's own login kept working, since the owner isn't a share and never comes
// down this path.
//
// How the resolution actually works: ask our own PMS for its machine id, GET
// plex.tv/api/servers/{machineId}/shared_servers with the OWNER token, and read
// the userID -> accessToken pairs out of the XML. resolveAccessToken is just a
// lookup in that map, so a plexId that isn't a share returns null and the
// caller keeps the durable token. See resolvePmsToken.ts for that fallback.

/**
 * Thrown when the shared-server map can't be built: /identity failed,
 * shared_servers returned non-OK, or the request never left the box.
 *
 * The point is that a failure is loud. An empty map would silently downgrade
 * every shared user back to the token that doesn't work.
 */
export class PlexSharedServerAccessError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "PlexSharedServerAccessError";
    this.status = status;
  }
}

// All from config. The owner token is what reads the share list; a signed-in
// user's own token never gets used in this file.
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

/**
 * Builds the per-server token resolver. One instance lives for the process
 * (created in index.ts), which is what gives the cache below anything to do.
 */
export function createSharedServerAccessResolver(
  options: SharedServerAccessResolverOptions,
) {
  const { baseUrl, ownerToken, clientId } = options;
  // The whole map, not per-user entries. One fetch covers everyone, and a new
  // share just waits out the TTL.
  let cache: { value: Map<number, string>; expiresAt: number } | null = null;

  // Returns the per-server access token for plexId, or null when that id is
  // not a shared user of this server (the normal owner case). Throws
  // PlexSharedServerAccessError on upstream failure — never silently empty.
  async function resolveAccessToken(plexId: number): Promise<string | null> {
    const map = await loadAccessMap();
    return map.get(plexId) ?? null;
  }

  // Cache read, or rebuild the whole plexId -> accessToken map.
  async function loadAccessMap(): Promise<Map<number, string>> {
    const now = Date.now();
    if (cache !== null && cache.expiresAt > now) {
      return cache.value;
    }

    // Sequential: the shared_servers URL is keyed on the machine id, so there's
    // nothing to parallelize.
    const machineIdentifier = await fetchMachineIdentifier();
    const value = await fetchSharedServerAccess(machineIdentifier);

    // Only a success lands in the cache. A thrown fetch retries next call
    // rather than pinning an empty map in place for ten minutes.
    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  }

  // Same /identity call connection.ts makes. Duplicated rather than shared, and
  // sharing.ts has a third copy.
  async function fetchMachineIdentifier(): Promise<string> {
    const body = await getJson(`${baseUrl}/identity`, {
      "X-Plex-Token": ownerToken,
      Accept: "application/json",
    });

    // Unwrap MediaContainer a level at a time so a missing layer reads as
    // absent instead of throwing.
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

  // Fetches the share list for our server and turns it into the lookup map.
  async function fetchSharedServerAccess(
    machineIdentifier: string,
  ): Promise<Map<number, string>> {
    // Token rides in the query string here. sharing.ts hits this same endpoint
    // with an X-Plex-Token header instead, so the two files disagree on style.
    const url =
      `https://plex.tv/api/servers/${machineIdentifier}/shared_servers` +
      `?X-Plex-Token=${encodeURIComponent(ownerToken)}`;

    const body = await getText(url, {
      "X-Plex-Client-Identifier": clientId,
    });

    return parseSharedServerAccess(body);
  }

  // JSON reader for /identity. Wraps every failure as PlexSharedServerAccessError.
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

  // Same as getJson except it hands back the raw body. shared_servers only ever
  // answers XML, so there's nothing to parse as JSON.
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

// Injected into routes/watch.ts and routes/library.ts, and stubbed in their
// tests. resolveAccessToken is the entire surface.
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
    // The (?:\s|<) prefix forces a real attribute boundary. Without it,
    // myuserID= reads as userID= and serverAccessToken= reads as accessToken=,
    // and you'd hand a user someone else's token or a garbage one.
    const userID = tag.match(/(?:\s|<)userID="(\d+)"/)?.[1];
    const accessToken = tag.match(/(?:\s|<)accessToken="([^"]+)"/)?.[1];
    if (userID === undefined || accessToken === undefined) {
      continue;
    }
    map.set(Number(userID), accessToken);
  }

  return map;
}
