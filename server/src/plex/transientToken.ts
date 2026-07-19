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

export class PlexTransientError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "PlexTransientError";
    this.status = status;
  }
}

export type TransientTokenMinterOptions = {
  // LAN URL of our PMS, e.g. http://10.0.0.10:32400 (config.plexBaseUrl).
  baseUrl: string;
  // X-Plex-Client-Identifier (config.plexClientId).
  clientId: string;
};

export function createTransientTokenMinter(
  options: TransientTokenMinterOptions,
) {
  const { baseUrl, clientId } = options;

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

export type TransientTokenMinter = ReturnType<
  typeof createTransientTokenMinter
>;

// Pulls the transient token out of an XML or JSON body. Prefers an explicit
// token/authToken attribute or field; falls back to any transient-prefixed
// token anywhere in the payload.
function extractTransientToken(body: string): string | null {
  const attr = body.match(/(?:authToken|token)\s*=\s*"([^"]+)"/i);
  if (attr !== null && attr[1] !== "") {
    return attr[1];
  }

  const field = body.match(/"(?:authToken|token)"\s*:\s*"([^"]+)"/i);
  if (field !== null && field[1] !== "") {
    return field[1];
  }

  const transient = body.match(/transient-[A-Za-z0-9._-]+/i);
  if (transient !== null) {
    return transient[0];
  }

  return null;
}
