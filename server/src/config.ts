// Reads and validates every environment variable the server needs, once, at
// boot. index.ts calls loadConfig() before it builds anything and exits the
// process if this throws, so the rule here is fail loud and fail early: a bad
// env var should stop startup, never turn into a confusing 500 later.
//
// The shape is one small parseX function per variable. Each either returns a
// clean value or throws with the variable's name in the message, so the log
// line at boot tells you exactly which one to fix. Three variables have
// defaults (PORT, NODE_ENV, PLEX_PRODUCT) and only ACCESS_REQUESTS_FILE is
// genuinely optional. Everything else is required, because every one of them is
// a credential or an upstream address the app can't work without.
//
// loadConfig takes the env as a parameter defaulting to process.env, which is
// what lets config.test.ts exercise all of this without mutating the real
// environment.

import path from "node:path";

// The validated, in-memory view of the environment. Built once in index.ts and
// passed by field into the clients and routers, so nothing downstream reads
// process.env directly.
export type AppConfig = {
  port: number;
  // Drives three things: Secure cookies, whether the built SPA gets served,
  // and whether the local .env is read at all.
  nodeEnv: "development" | "production" | "test";
  // X-Plex-Client-Identifier, sent on every Plex call. It's how Plex identifies
  // this client, so it needs to stay stable across restarts.
  plexClientId: string;
  plexProduct: string; // X-Plex-Product, defaults to "Tyflix"
  plexBaseUrl: string; // LAN address of the PMS, no trailing slash
  // Owner token. Used for server-wide reads and for resolving other users'
  // per-server tokens, never handed to a browser.
  plexToken: string;
  // HMAC key for the session cookie signature and the HKDF input for the
  // AES-256-GCM key that wraps each user's Plex token. Rotating it invalidates
  // every live session and every stored token blob with it.
  sessionSecret: string;
  seerrUrl: string; // no trailing slash
  seerrApiKey: string;
  dashboardUrl: string; // host-metrics service for the admin views, no trailing slash
  tmdbApiKey: string;
  /** Absolute path to the access-requests JSON file. Absent = feature off. */
  accessRequestsFile?: string;
};

/**
 * Required-string gate shared by every parser below.
 *
 * Missing or whitespace-only fails before `check` ever runs, so a check only
 * has to worry about the format of a value that's actually there. Parsers with
 * nothing extra to assert pass `() => null`.
 *
 * @param name the environment variable name, used verbatim in the error so the
 * boot log names the variable to fix
 * @param check returns an error phrase, or null when the value is acceptable
 * @throws Error when the value is absent, blank, or `check` rejects it
 */
export function validate(
  name: string,
  value: string | undefined,
  check: (raw: string) => string | null,
): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Invalid ${name}: missing or empty`);
  }
  const error = check(value);
  if (error !== null) {
    throw new Error(`Invalid ${name}: ${error}`);
  }
  return value;
}

// Defaults to 4000, which is what the Vite dev proxy and the Dockerfile's
// EXPOSE both assume. Rejects anything outside the valid TCP range.
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 4000;
  }
  const validated = validate("PORT", raw, (v) => {
    if (!/^\d+$/.test(v)) {
      return "must be a numeric port";
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return "must be an integer between 1 and 65535";
    }
    return null;
  });
  return Number(validated);
}

// Unset means development. A typo like "prod" is rejected rather than silently
// treated as non-production, which would quietly drop Secure off the session
// cookie and skip serving the SPA.
function parseNodeEnv(
  raw: string | undefined,
): AppConfig["nodeEnv"] {
  if (raw === undefined || raw.trim() === "") {
    return "development";
  }
  const validated = validate("NODE_ENV", raw, (v) => {
    if (v !== "development" && v !== "production" && v !== "test") {
      return 'must be "development", "production", or "test"';
    }
    return null;
  });
  return validated as AppConfig["nodeEnv"];
}

// Required, with no format check past non-empty.
function parsePlexClientId(raw: string | undefined): string {
  return validate("PLEX_CLIENT_ID", raw, () => null);
}

// The product name this client reports to Plex. Defaults to "Tyflix" and
// there's rarely a reason to override it.
function parsePlexProduct(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return "Tyflix";
  }
  return validate("PLEX_PRODUCT", raw, () => null);
}

// 16 characters is a floor, not a recommendation. This one secret both signs
// the cookie and derives the token-encryption key, so it should be long and
// random.
function parseSessionSecret(raw: string | undefined): string {
  return validate("SESSION_SECRET", raw, (v) => {
    if (v.length < 16) {
      return "must be at least 16 characters";
    }
    return null;
  });
}

// Trailing slashes get stripped here and in the other two URL parsers, so
// callers can build paths as `${baseUrl}/whatever` without producing a double
// slash. None of the three check that the value parses as a URL, only that it's
// present.
function parseSeerrUrl(raw: string | undefined): string {
  const validated = validate("SEERR_URL", raw, () => null);
  return validated.replace(/\/+$/, "");
}

function parseSeerrApiKey(raw: string | undefined): string {
  return validate("SEERR_API_KEY", raw, () => null);
}

function parsePlexBaseUrl(raw: string | undefined): string {
  const validated = validate("PLEX_BASEURL", raw, () => null);
  return validated.replace(/\/+$/, "");
}

// The owner's long-lived Plex token. Presence is all that's checked here; a
// revoked or wrong one only fails later, when something actually calls Plex.
function parsePlexToken(raw: string | undefined): string {
  return validate("PLEX_TOKEN", raw, () => null);
}

function parseDashboardUrl(raw: string | undefined): string {
  const validated = validate("DASHBOARD_URL", raw, () => null);
  return validated.replace(/\/+$/, "");
}

function parseTmdbApiKey(raw: string | undefined): string {
  return validate("TMDB_API_KEY", raw, () => null);
}

/**
 * Truly optional: unset/whitespace → feature off (undefined). When set, must
 * be a non-empty absolute path — a relative path means the Docker volume mount
 * is wrong and should fail loud at boot.
 */
function parseAccessRequestsFile(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(
      "Invalid ACCESS_REQUESTS_FILE: must be an absolute path",
    );
  }
  return trimmed;
}

/**
 * Validates the whole environment and returns the config the rest of the server
 * runs on. Called once from index.ts at boot.
 *
 * @param env defaults to process.env; tests pass a literal object instead
 * @throws Error on the first variable that fails, naming it in the message
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Resolved up front so the conditional spread at the bottom can leave the key
  // off the object entirely instead of setting it to undefined.
  const accessRequestsFile = parseAccessRequestsFile(env.ACCESS_REQUESTS_FILE);
  return {
    port: parsePort(env.PORT),
    nodeEnv: parseNodeEnv(env.NODE_ENV),
    plexClientId: parsePlexClientId(env.PLEX_CLIENT_ID),
    plexProduct: parsePlexProduct(env.PLEX_PRODUCT),
    plexBaseUrl: parsePlexBaseUrl(env.PLEX_BASEURL),
    plexToken: parsePlexToken(env.PLEX_TOKEN),
    sessionSecret: parseSessionSecret(env.SESSION_SECRET),
    seerrUrl: parseSeerrUrl(env.SEERR_URL),
    seerrApiKey: parseSeerrApiKey(env.SEERR_API_KEY),
    dashboardUrl: parseDashboardUrl(env.DASHBOARD_URL),
    tmdbApiKey: parseTmdbApiKey(env.TMDB_API_KEY),
    ...(accessRequestsFile !== undefined ? { accessRequestsFile } : {}),
  };
}
