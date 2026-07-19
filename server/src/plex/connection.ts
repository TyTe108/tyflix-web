// Resolves our Plex Media Server's direct, external plex.direct HTTPS base URL —
// the address a browser can stream from. Uses the OWNER token (config.plexToken),
// never a per-user session token. Fails loud rather than ever handing back a
// relay URI (relay is capped ~2 Mbps / SD and unusable for playback).

export class PlexConnectionError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "PlexConnectionError";
    this.status = status;
  }
}

export type PlexConnectionResolverOptions = {
  // LAN URL of our PMS, e.g. http://10.0.0.10:32400 (config.plexBaseUrl).
  baseUrl: string;
  // Owner/server token used against both /identity and plex.tv (config.plexToken).
  token: string;
  // X-Plex-Client-Identifier (config.plexClientId).
  clientId: string;
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

// The resolved URI rarely changes, so cache it briefly to avoid re-hitting
// plex.tv on every play decision.
const CACHE_TTL_MS = 10 * 60 * 1000;

export function createPlexConnectionResolver(
  options: PlexConnectionResolverOptions,
) {
  const { baseUrl, token, clientId } = options;
  let cache: { uri: string; expiresAt: number } | null = null;

  // Returns our server's direct, external HTTPS (.plex.direct) base URL.
  // Throws PlexConnectionError if the server can't be matched or only
  // relay/local connections exist.
  async function resolveExternalUri(): Promise<string> {
    const now = Date.now();
    if (cache !== null && cache.expiresAt > now) {
      return cache.uri;
    }

    const machineIdentifier = await fetchMachineIdentifier();
    const uri = await fetchDirectExternalUri(machineIdentifier);

    cache = { uri, expiresAt: now + CACHE_TTL_MS };
    return uri;
  }

  async function fetchMachineIdentifier(): Promise<string> {
    const body = await getJson(`${baseUrl}/identity`, {
      "X-Plex-Token": token,
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
      throw new PlexConnectionError(
        "Plex /identity returned no machineIdentifier",
      );
    }

    return machineIdentifier;
  }

  async function fetchDirectExternalUri(
    machineIdentifier: string,
  ): Promise<string> {
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

    // Direct external only: never local, never relay. Relay is bandwidth-capped
    // and unusable for streaming, so we do NOT fall back to it.
    const external = connections.filter(
      (conn) => conn.local === false && conn.relay === false,
    );

    if (external.length === 0) {
      throw new PlexConnectionError(
        "Plex server has no direct external connection (relay/local only)",
      );
    }

    // Prefer the HTTPS .plex.direct URI (valid cert + streamable in a browser).
    const preferred =
      external.find(
        (conn) =>
          conn.protocol === "https" && conn.uri.includes(".plex.direct"),
      ) ??
      external.find((conn) => conn.protocol === "https") ??
      external[0];

    return preferred.uri;
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

  return { resolveExternalUri };
}

export type PlexConnectionResolver = ReturnType<
  typeof createPlexConnectionResolver
>;

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
