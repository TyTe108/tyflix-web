// plex.tv account client: Plex's PIN login flow, plus the one call that trades
// a token for a user identity. This is the cloud half of Plex. It only ever
// talks to plex.tv, never to the media server at home, and that server has its
// own client in plex/server.ts with its own base URL and token.
//
// How sign-in runs: POST /api/auth/plex/start calls createPin and buildAuthUrl,
// the SPA opens that URL in a popup, and GET /api/auth/plex/check polls checkPin
// until Plex hands back an authToken. getUser then turns that token into the
// account id the rest of the app keys on. routes/auth.ts is the only caller.
//
// Every response gets shape-checked before it's trusted. The token checkPin
// returns goes straight into the encrypted half of the session cookie, so a
// surprise body shouldn't get that far.

// A freshly minted PIN. `id` is what we poll with; `code` is the short string
// that goes into the auth URL the user's popup opens.
export type PlexPin = {
  id: number;
  code: string;
};

// One poll result. A null authToken means the user hasn't finished signing in
// yet, so it's "keep polling", not "failed".
export type PlexPinStatus = {
  authToken: string | null;
};

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
 * way and only uses the message.
 */
export class PlexUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PlexUpstreamError";
    this.status = status;
  }
}

// How we identify ourselves to plex.tv. The same client id goes out on all
// three legs of the PIN flow (create, the auth URL, the poll), so it has to be
// one stable value.
export type PlexClientOptions = {
  clientId: string; // X-Plex-Client-Identifier (config.plexClientId)
  product: string; // X-Plex-Product, defaults to "Tyflix" (config.plexProduct)
};

/**
 * Builds the plex.tv account client.
 *
 * Nothing here needs the owner's server token. The PIN flow is how a user
 * proves who they are, and getUser runs on whatever token came back from it.
 */
export function createPlexClient(options: PlexClientOptions) {
  const { clientId, product } = options;

  // Asks plex.tv for a new PIN. Two fields matter out of the response: the id
  // we poll on and the code that goes in the auth URL.
  async function createPin(): Promise<PlexPin> {
    const res = await fetch(
      "https://clients.plex.tv/api/v2/pins?strong=true",
      {
        method: "POST",
        headers: {
          "X-Plex-Client-Identifier": clientId,
          "X-Plex-Product": product,
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      throw new PlexUpstreamError(
        `Plex createPin failed (${res.status})`,
        res.status,
      );
    }

    // A pin with either half missing is useless downstream, so fail here rather
    // than hand back a half-built object the poller would chase forever.
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { id?: unknown }).id !== "number" ||
      typeof (body as { code?: unknown }).code !== "string"
    ) {
      throw new PlexUpstreamError(
        "Plex createPin returned unexpected body",
        res.status,
      );
    }

    return {
      id: (body as { id: number }).id,
      code: (body as { code: string }).code,
    };
  }

  // Builds the plex.tv sign-in URL the SPA opens in a popup. It's a page for a
  // human, not an API call, so the server never fetches it. The code is what
  // ties whatever happens in that popup back to the pin we're polling.
  function buildAuthUrl(code: string): string {
    const params = new URLSearchParams({
      clientID: clientId,
      code,
      "context[device][product]": product,
    });
    return `https://app.plex.tv/auth#?${params.toString()}`;
  }

  // One poll of a pin. Returns { authToken: null } while the user is still on
  // the Plex page, and the durable token once they've approved.
  async function checkPin(id: number): Promise<PlexPinStatus> {
    const res = await fetch(
      `https://clients.plex.tv/api/v2/pins/${id}`,
      {
        method: "GET",
        headers: {
          "X-Plex-Client-Identifier": clientId,
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      throw new PlexUpstreamError(
        `Plex checkPin failed (${res.status})`,
        res.status,
      );
    }

    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) {
      throw new PlexUpstreamError(
        "Plex checkPin returned unexpected body",
        res.status,
      );
    }

    // Absent and null both mean "not signed in yet", which is the common case
    // on a poll. A present-but-not-a-string token is a different animal and
    // throws, so we never stuff a number or an object into a session.
    const authToken = (body as { authToken?: unknown }).authToken;
    if (authToken === undefined || authToken === null) {
      return { authToken: null };
    }
    if (typeof authToken !== "string") {
      throw new PlexUpstreamError(
        "Plex checkPin returned unexpected authToken",
        res.status,
      );
    }

    return { authToken };
  }

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

  return { createPin, buildAuthUrl, checkPin, getUser };
}

// What routes/auth.ts depends on, so the tests can pass a hand-rolled stand-in.
export type PlexClient = ReturnType<typeof createPlexClient>;
