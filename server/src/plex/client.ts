// plex.tv account client: trades a browser-obtained Plex auth token for the
// account identity (plexId, username, email, avatar). This is the cloud half
// of Plex. It only ever talks to plex.tv, never to the media server at home,
// and that server has its own client in plex/server.ts with its own base URL
// and token.
//
// routes/auth.ts is the only caller: /plex/complete hands getUser the token
// the browser posted, then joins on plexId in Seerr. Every response gets
// shape-checked before it's trusted.

// The plex.tv account behind a token.
export type PlexUser = {
  id: number; // plexId; Seerr stores the same number, which is how the two join
  username: string;
  email: string | null; // null when plex.tv omits it or sends a non-string
  thumb: string | null; // avatar URL, same nullability rule
};

/**
 * Thrown for any plex.tv failure: a non-2xx response, or a 2xx whose body is
 * missing fields we need.
 *
 * `status` is the upstream HTTP status, so a body-shape failure carries the 2xx
 * it arrived with rather than an error code. routes/auth.ts answers 502 either
 * way and only uses the message (except a getUser 401 on /plex/complete, which
 * maps to 401).
 */
export class PlexUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PlexUpstreamError";
    this.status = status;
  }
}

// How we identify ourselves to plex.tv on getUser.
export type PlexClientOptions = {
  clientId: string; // X-Plex-Client-Identifier (config.plexClientId)
};

/**
 * Builds the plex.tv account client.
 *
 * Nothing here needs the owner's server token. getUser runs on whatever token
 * the browser obtained during the PIN handshake and posted to /plex/complete.
 */
export function createPlexClient(options: PlexClientOptions) {
  const { clientId } = options;

  // Reads the plex.tv account that owns a token. This is where the plexId comes
  // from, and routes/auth.ts hands that id to Seerr to find the matching member
  // record.
  async function getUser(authToken: string): Promise<PlexUser> {
    const res = await fetch("https://plex.tv/api/v2/user", {
      method: "GET",
      headers: {
        "X-Plex-Token": authToken,
        "X-Plex-Client-Identifier": clientId,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new PlexUpstreamError(
        `Plex getUser failed (${res.status})`,
        res.status,
      );
    }

    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { id?: unknown }).id !== "number" ||
      typeof (body as { username?: unknown }).username !== "string"
    ) {
      throw new PlexUpstreamError(
        "Plex getUser returned unexpected body",
        res.status,
      );
    }

    // id and username are load-bearing and already validated above. email and
    // thumb are decoration, so anything that isn't a string collapses to null
    // instead of failing the login.
    const email = (body as { email?: unknown }).email;
    const thumb = (body as { thumb?: unknown }).thumb;

    return {
      id: (body as { id: number }).id,
      username: (body as { username: string }).username,
      email: typeof email === "string" ? email : null,
      thumb: typeof thumb === "string" ? thumb : null,
    };
  }

  return { getUser };
}

// What routes/auth.ts depends on, so the tests can pass a hand-rolled stand-in.
export type PlexClient = ReturnType<typeof createPlexClient>;
