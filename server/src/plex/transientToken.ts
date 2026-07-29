// Exchanges a user's durable Plex token for a short-lived Plex TRANSIENT token
// (delegation/all scope). The transient inherits the caller's access level and
// is valid ~48h / until server restart, so it's what we hand to a browser
// player instead of the durable token.
//
// Live response shape (verified against a real PMS): /security/token returns
// XML regardless of Accept, e.g.
//   <?xml version="1.0" encoding="UTF-8"?>
//   <MediaContainer size="0" token="transient-24b68e46-3eb5-449e-8295-ff59e9a5e6cb"/>
// The transient is the MediaContainer `token` attribute and is prefixed
// "transient-". We read the body as text and extract defensively (attribute or
// JSON field, with a transient-prefixed regex fallback) so a JSON variant or
// minor shape drift still works.
//
// The reason any of this exists: the browser authenticates to Plex on its own,
// because video doesn't go through our server or the tunnel. Some token has to
// sit in that URL. The durable one would then live in the page, so it stays
// server-side and a throwaway goes out in its place.
//
// routes/watch.ts mints one per play descriptor, and the token it passes in is
// already the PMS token from resolvePmsToken, so a shared user's transient
// inherits their access and not the owner's.

/**
 * Thrown when no transient comes back: the request failed, /security/token
 * answered non-OK, or the body had nothing token-shaped in it.
 *
 * Defaults to 502. buildPlayDescriptor in routes/watch.ts lets it propagate
 * rather than returning a half-built descriptor, so a mint failure reaches the
 * user as "can't play" and never as a player with a dead URL in it.
 */
export class PlexTransientError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "PlexTransientError";
    this.status = status;
  }
}

// No token in here. The user's token arrives per call, since the whole point is
// that the transient inherits whoever is asking.
export type TransientTokenMinterOptions = {
  // LAN URL of our PMS, e.g. http://10.0.0.10:32400 (config.plexBaseUrl).
  baseUrl: string;
  // X-Plex-Client-Identifier (config.plexClientId).
  clientId: string;
};

/**
 * Builds the transient-token minter. Stateless and uncached, unlike the other
 * resolvers here: these are short-lived by design, so reusing one across plays
 * would defeat the point.
 */
export function createTransientTokenMinter(
  options: TransientTokenMinterOptions,
) {
  const { baseUrl, clientId } = options;

  // Trades a durable Plex token for a transient one. The call goes to our PMS
  // over the LAN, not to plex.tv.
  async function mint(userToken: string): Promise<string> {
    const url = `${baseUrl}/security/token?type=delegation&scope=all`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Plex-Token": userToken,
          "X-Plex-Client-Identifier": clientId,
        },
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Plex transient token request failed";
      throw new PlexTransientError(message);
    }

    if (!res.ok) {
      throw new PlexTransientError(
        `Plex /security/token failed (${res.status})`,
      );
    }

    // Read as text, not JSON. See the header: this endpoint answers XML no
    // matter what we ask for, and res.json() would just throw on it.
    const body = await res.text();
    const token = extractTransientToken(body);
    if (token === null || token === "") {
      throw new PlexTransientError(
        "Plex /security/token returned no transient token",
      );
    }

    return token;
  }

  return { mint };
}

// Injected into routes/watch.ts and stubbed in its tests, so no test ever hits
// a real /security/token.
export type TransientTokenMinter = ReturnType<
  typeof createTransientTokenMinter
>;

// Pulls the transient token out of an XML or JSON body. Prefers an explicit
// token/authToken attribute or field; falls back to any transient-prefixed
// token anywhere in the payload.
function extractTransientToken(body: string): string | null {
  // XML attribute first, since that's the shape a real PMS returns.
  const attr = body.match(/(?:authToken|token)\s*=\s*"([^"]+)"/i);
  if (attr !== null && attr[1] !== "") {
    return attr[1];
  }

  // Then a JSON field, covering a hypothetical JSON variant. The test suite
  // exercises this path with an authToken field.
  const field = body.match(/"(?:authToken|token)"\s*:\s*"([^"]+)"/i);
  if (field !== null && field[1] !== "") {
    return field[1];
  }

  // Last resort: grab anything that looks like a transient, wherever it sits.
  // Loose on purpose, and only reached when both named lookups miss.
  const transient = body.match(/transient-[A-Za-z0-9._-]+/i);
  if (transient !== null) {
    return transient[0];
  }

  return null;
}
