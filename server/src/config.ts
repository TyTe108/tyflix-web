export type AppConfig = {
  port: number;
  nodeEnv: "development" | "production" | "test";
  plexClientId: string;
  plexProduct: string;
};

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

function parsePlexClientId(raw: string | undefined): string {
  return validate("PLEX_CLIENT_ID", raw, () => null);
}

function parsePlexProduct(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return "Tyflix";
  }
  return validate("PLEX_PRODUCT", raw, () => null);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parsePort(env.PORT),
    nodeEnv: parseNodeEnv(env.NODE_ENV),
    plexClientId: parsePlexClientId(env.PLEX_CLIENT_ID),
    plexProduct: parsePlexProduct(env.PLEX_PRODUCT),
  };
}
