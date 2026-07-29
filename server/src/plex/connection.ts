// Resolves our Plex Media Server's direct plex.direct base URLs — the addresses
// a browser can stream from. Returns BOTH the remote (external) and local URIs
// so the player can use whichever the client can reach (a LAN browser can't hit
// the external public IP via NAT hairpin). Uses the OWNER token
// (config.plexToken), never a per-user session token. Relay connections are
// excluded entirely (relay is capped ~2 Mbps / SD and unusable for playback).
//
// This is the piece that keeps video off the Cloudflare Tunnel. Every other
// call in Tyflix rides the tunnel; playback doesn't. Handing the browser a
// plex.direct URL means it opens its own HTTPS connection to Plex, and the only
// thing the tunnel carries is the JSON describing where to go. routes/watch.ts
// calls this once per play descriptor.
//
// Two steps, two hosts: ask our own PMS who it is (/identity), then ask plex.tv
// which addresses it advertises for that machine id. plex.tv answers for every
// server on the account, which is why the machine id matters.

/**
 * Thrown when we can't produce a browser-reachable address: /identity or
 * plex.tv failed, our machine id isn't in the resource list, or the only
 * remote connections on offer are relays.
 *
 * Defaults to 502 because every case is an upstream problem, not the caller's.
 */
export class PlexConnectionError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "PlexConnectionError";
    this.status = status;
  }
}

// Everything the resolver needs, all from config. No per-request state.
export type PlexConnectionResolverOptions = {
  // LAN URL of our PMS, e.g. http://10.0.0.10:32400 (config.plexBaseUrl).
  baseUrl: string;
  // Owner/server token used against both /identity and plex.tv (config.plexToken).
  token: string;
  // X-Plex-Client-Identifier (config.plexClientId).
  clientId: string;
};

// Direct plex.direct URIs for our server. remote is required (external,
// browser-reachable off-LAN); local is null when the server advertises none.
export type PlexConnections = {
  local: string | null;
  remote: string;
};

// A single connection entry from plex.tv/api/v2/resources. Only the fields we
// rely on are typed; the live payload also carries address, port, and IPv6.
type PlexResourceConnection = {
  protocol: string;
  uri: string;
  local: boolean;
  relay: boolean;
};

const RESOURCES_URL =
  "https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1";

// The resolved URIs rarely change, so cache them briefly to avoid re-hitting
// plex.tv on every play decision.
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Builds the connection resolver. One instance is created at startup in
 * index.ts and shared, which is what makes the cache below worth having.
 */
export function createPlexConnectionResolver(
  options: PlexConnectionResolverOptions,
) {
  const { baseUrl, token, clientId } = options;
  // Process-wide, not per-user: these URLs are a property of the server, and
  // the token that reads them is the owner's either way.
  let cache: { value: PlexConnections; expiresAt: number } | null = null;

  // Returns our server's direct local + remote HTTPS (.plex.direct) base URLs.
  // Throws PlexConnectionError if the server can't be matched or exposes no
  // non-relay remote connection.
  async function resolveConnections(): Promise<PlexConnections> {
    const now = Date.now();
    if (cache !== null && cache.expiresAt > now) {
      return cache.value;
    }

    // Sequential on purpose: the resources lookup can't filter to our server
    // without the machine id from /identity.
    const machineIdentifier = await fetchMachineIdentifier();
    const value = await fetchDirectConnections(machineIdentifier);

    // Only a success gets cached, so a failed resolve retries on the next play
    // rather than poisoning the next ten minutes.
    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  }

  // Asks our own PMS for its machine id over the LAN. That id is the key we
  // match on in plex.tv's account-wide resource list.
  async function fetchMachineIdentifier(): Promise<string> {
    const body = await getJson(`${baseUrl}/identity`, {
      "X-Plex-Token": token,
      Accept: "application/json",
    });

    // Plex wraps everything in MediaContainer. Unwrap a level at a time so a
    // missing layer reads as absent instead of throwing a TypeError.
    const container =
      typeof body === "object" && body !== null
        ? (body as { MediaContainer?: unknown }).MediaContainer
        : null;
    const machineIdentifier =
      typeof container === "object" && container !== null
        ? (container as { machineIdentifier?: unknown }).machineIdentifier
        : undefined;

    if (typeof machineIdentifier !== "string" || machineIdentifier === "") {
      throw new PlexConnectionError(
        "Plex /identity returned no machineIdentifier",
      );
    }

    return machineIdentifier;
  }

  // Pulls our server's row out of plex.tv's resource list and picks one usable
  // address from each side of the NAT.
  async function fetchDirectConnections(
    machineIdentifier: string,
  ): Promise<PlexConnections> {
    const body = await getJson(RESOURCES_URL, {
      "X-Plex-Token": token,
      "X-Plex-Client-Identifier": clientId,
      Accept: "application/json",
    });

    if (!Array.isArray(body)) {
      throw new PlexConnectionError(
        "Plex /resources returned an unexpected body",
      );
    }

    // /resources lists every server and player on the account, so match on the
    // machine id rather than taking the first row.
    const resource = body.find(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        (row as { clientIdentifier?: unknown }).clientIdentifier ===
          machineIdentifier,
    );

    if (resource === undefined) {
      throw new PlexConnectionError(
        `No Plex resource matches machineIdentifier ${machineIdentifier}`,
      );
    }

    const connections = parseConnections(
      (resource as { connections?: unknown }).connections,
    );

    // Relay is bandwidth-capped and unusable for streaming, so it is excluded
    // from both local and remote — we never fall back to it.
    const remote = pickPreferredUri(
      connections.filter(
        (conn) => conn.local === false && conn.relay === false,
      ),
    );

    if (remote === null) {
      throw new PlexConnectionError(
        "Plex server has no direct remote connection (relay/local only)",
      );
    }

    // local is best-effort — null when the server advertises none.
    const local = pickPreferredUri(
      connections.filter(
        (conn) => conn.local === true && conn.relay === false,
      ),
    );

    return { local, remote };
  }

  // Every failure mode collapses into PlexConnectionError so callers have one
  // type to catch. routes/watch.ts turns it into a 502 and logs the message.
  async function getJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    let res: Response;
    try {
      // A rejected fetch is DNS, a refused connection, or TLS. Keep the
      // original message; it's the only clue about which.
      res = await fetch(url, { method: "GET", headers });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Plex connection request failed";
      throw new PlexConnectionError(message);
    }

    if (!res.ok) {
      throw new PlexConnectionError(
        `Plex request ${url} failed (${res.status})`,
      );
    }

    return res.json();
  }

  return { resolveConnections };
}

// The shape routes/watch.ts depends on. Injected, so tests hand it a stub
// instead of reaching plex.tv.
export type PlexConnectionResolver = ReturnType<
  typeof createPlexConnectionResolver
>;

// Prefer the HTTPS .plex.direct URI (valid cert + streamable in a browser),
// then any https, then whatever is left. Returns null for an empty list.
function pickPreferredUri(
  connections: PlexResourceConnection[],
): string | null {
  const preferred =
    connections.find(
      (conn) => conn.protocol === "https" && conn.uri.includes(".plex.direct"),
    ) ??
    connections.find((conn) => conn.protocol === "https") ??
    connections[0];

  return preferred?.uri ?? null;
}

// Narrows plex.tv's connection array to the four fields we branch on. A row
// missing any of them is dropped rather than half-trusted, and a non-array
// payload yields an empty list, which the caller then reports as "no remote".
function parseConnections(value: unknown): PlexResourceConnection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: PlexResourceConnection[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const protocol = (row as { protocol?: unknown }).protocol;
    const uri = (row as { uri?: unknown }).uri;
    const local = (row as { local?: unknown }).local;
    const relay = (row as { relay?: unknown }).relay;

    if (
      typeof protocol === "string" &&
      typeof uri === "string" &&
      typeof local === "boolean" &&
      typeof relay === "boolean"
    ) {
      parsed.push({ protocol, uri, local, relay });
    }
  }
  return parsed;
}
