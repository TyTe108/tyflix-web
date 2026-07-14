export type PlexPin = {
  id: number;
  code: string;
};

export type PlexPinStatus = {
  authToken: string | null;
};

export type PlexUser = {
  id: number;
  username: string;
  email: string | null;
  thumb: string | null;
};

export class PlexUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PlexUpstreamError";
    this.status = status;
  }
}

export type PlexClientOptions = {
  clientId: string;
  product: string;
};

export function createPlexClient(options: PlexClientOptions) {
  const { clientId, product } = options;

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

  function buildAuthUrl(code: string): string {
    const params = new URLSearchParams({
      clientID: clientId,
      code,
      "context[device][product]": product,
    });
    return `https://app.plex.tv/auth#?${params.toString()}`;
  }

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

export type PlexClient = ReturnType<typeof createPlexClient>;
