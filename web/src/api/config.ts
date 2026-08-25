// Client for the server's config router (server/src/routes/config.ts), mounted
// at /api/config. Public feature flags, readable without a session, because the
// login screen needs to know whether to show a "request access" link before
// anyone has signed in.
//
// Flags only, never secrets. The server side of this endpoint carries the same
// warning, and it'll be tempting to grow it later.
//
// Module-level cache plus in-flight dedupe: several components mount at once on
// a cold page and they should share one probe, not race four. The cache lives
// for the page lifetime, which is fine because these values only change when
// the server restarts.

export type PublicConfig = {
  accessRequestsEnabled: boolean;
  transmissionEnabled: boolean;
};

const DISABLED: PublicConfig = {
  accessRequestsEnabled: false,
  transmissionEnabled: false,
};

let cached: PublicConfig | null = null;
let inflight: Promise<PublicConfig> | null = null;

/**
 * Fetch public feature flags once per page load. Fail closed: any probe
 * failure is treated as every feature off — never advertise a broken form.
 *
 * Never throws. A caller can rely on getting a PublicConfig back no matter what
 * happened on the wire.
 */
export async function fetchPublicConfig(): Promise<PublicConfig> {
  if (cached !== null) {
    return cached;
  }
  if (inflight !== null) {
    return inflight;
  }

  inflight = probe().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function probe(): Promise<PublicConfig> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) {
      cached = DISABLED;
      return cached;
    }
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { accessRequestsEnabled?: unknown }).accessRequestsEnabled !==
        "boolean" ||
      typeof (body as { transmissionEnabled?: unknown }).transmissionEnabled !==
        "boolean"
    ) {
      cached = DISABLED;
      return cached;
    }
    cached = {
      accessRequestsEnabled: (body as { accessRequestsEnabled: boolean })
        .accessRequestsEnabled,
      transmissionEnabled: (body as { transmissionEnabled: boolean })
        .transmissionEnabled,
    };
    return cached;
  } catch {
    cached = DISABLED;
    return cached;
  }
}
