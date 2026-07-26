export type PublicConfig = {
  accessRequestsEnabled: boolean;
};

const DISABLED: PublicConfig = { accessRequestsEnabled: false };

let cached: PublicConfig | null = null;
let inflight: Promise<PublicConfig> | null = null;

/**
 * Fetch public feature flags once per page load. Fail closed: any probe
 * failure is treated as every feature off — never advertise a broken form.
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
        "boolean"
    ) {
      cached = DISABLED;
      return cached;
    }
    cached = {
      accessRequestsEnabled: (body as { accessRequestsEnabled: boolean })
        .accessRequestsEnabled,
    };
    return cached;
  } catch {
    cached = DISABLED;
    return cached;
  }
}
