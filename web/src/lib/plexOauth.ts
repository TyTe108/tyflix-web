// Browser-side Plex PIN handshake. LoginPage calls these so the PIN is born
// from the user's own IP (create + poll against plex.tv), which is what stops
// Plex from showing the "Security Alert" interstitial that appears when the
// server creates the PIN from a different egress.
//
// plex.tv's CORS allows these calls from any origin; Overseerr and Seerr rely
// on that in production too. The authToken that comes back is held in caller
// scope only and posted once to POST /api/auth/plex/complete — never persisted
// in the browser.

// Mirrors the server's PLEX_PRODUCT default. A fork renaming the product edits
// this constant (and the matching server config, until that default goes away).
const PLEX_PRODUCT = "Tyflix";

const CLIENT_ID_STORAGE_KEY = "tyflix.plexClientId";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PlexPin = {
  id: number;
  code: string;
};

export type PlexPinStatus = {
  authToken: string | null;
};

/**
 * Returns the per-browser Plex client identifier, minting and persisting one
 * on first call under localStorage key `tyflix.plexClientId`.
 *
 * Prefers `crypto.randomUUID()`, falls back to a UUIDv4 built from
 * `crypto.getRandomValues`, and throws when neither API exists (never
 * `Math.random`).
 *
 * @throws Error when the browser has no usable crypto API for minting an id.
 */
export function getPlexClientId(): string {
  const existing = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing !== null && existing !== "") {
    return existing;
  }

  const id = mintClientId();
  localStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
  return id;
}

function mintClientId(): string {
  const cryptoApi = globalThis.crypto;

  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    return uuidV4FromGetRandomValues(cryptoApi.getRandomValues.bind(cryptoApi));
  }

  throw new Error(
    "This browser cannot mint a Plex client id (crypto.randomUUID and crypto.getRandomValues are unavailable).",
  );
}

function uuidV4FromGetRandomValues(
  getRandomValues: (array: Uint8Array) => Uint8Array,
): string {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  // RFC 4122 version 4 + variant 1.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_V4_RE.test(id)) {
    throw new Error("Failed to mint a UUIDv4 Plex client id.");
  }
  return id;
}

/**
 * Asks plex.tv for a new PIN. `id` is what we poll with; `code` goes into the
 * auth URL the popup opens.
 *
 * @throws Error on a non-2xx response, or when the body is missing a numeric
 * `id` or string `code`.
 */
export async function createPlexPin(clientId: string): Promise<PlexPin> {
  const res = await fetch("https://plex.tv/api/v2/pins?strong=true", {
    method: "POST",
    headers: {
      "X-Plex-Client-Identifier": clientId,
      "X-Plex-Product": PLEX_PRODUCT,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Plex createPin failed (${res.status})`);
  }

  const body: unknown = await res.json();
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { id?: unknown }).id !== "number" ||
    typeof (body as { code?: unknown }).code !== "string"
  ) {
    throw new Error(
      "Plex createPin returned unexpected body (missing id or code)",
    );
  }

  return {
    id: (body as { id: number }).id,
    code: (body as { code: string }).code,
  };
}

/**
 * Builds the plex.tv sign-in URL the popup navigates to. Encoding matches the
 * server's former `buildAuthUrl` (`URLSearchParams`).
 */
export function buildPlexAuthUrl(code: string, clientId: string): string {
  const params = new URLSearchParams({
    clientID: clientId,
    code,
    "context[device][product]": PLEX_PRODUCT,
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

/**
 * One poll of a PIN. Returns `{ authToken: null }` while the user is still on
 * the Plex page (token absent or null), and the durable token once approved.
 *
 * @throws Error on a non-2xx response, or when `authToken` is present but not
 * a string.
 */
export async function checkPlexPin(
  pinId: number,
  clientId: string,
): Promise<PlexPinStatus> {
  const res = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
    method: "GET",
    headers: {
      "X-Plex-Client-Identifier": clientId,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Plex checkPin failed (${res.status})`);
  }

  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("Plex checkPin returned unexpected body");
  }

  const authToken = (body as { authToken?: unknown }).authToken;
  if (authToken === undefined || authToken === null) {
    return { authToken: null };
  }
  if (typeof authToken !== "string") {
    throw new Error("Plex checkPin returned a non-string authToken");
  }

  return { authToken };
}
