// Thin proxy to the host-metrics service that backs the admin System panel:
// CPU, memory, load, temperatures, GPU transcode engines, per-volume storage.
//
// It's a separate service reached over DASHBOARD_URL, and this client is
// deliberately dumb about it. No response mapping at all: routes/admin.ts
// forwards /api/{system,users,jobs,containers} straight through and the JSON
// reaches the browser as-is, which means the admin UI is coupled to that
// service's shape rather than to anything defined here.
//
// What this file adds over a bare fetch is a 10 second timeout, which earns its
// place because the admin dashboard polls these endpoints continuously.

/**
 * A failure reaching the metrics service.
 *
 * `status` is the service's own code, or 502 when it never answered. A timeout
 * lands in the 502 branch, since aborting makes fetch throw.
 */
export class DashboardUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DashboardUpstreamError";
    this.status = status;
  }
}

export type DashboardClientOptions = {
  baseUrl: string; // DASHBOARD_URL, trailing slash already stripped by config
};

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Builds the metrics client. Exposes a single generic getJson, because every
 * admin panel endpoint is the same shape of pass-through.
 */
export function createDashboardClient(options: DashboardClientOptions) {
  const { baseUrl } = options;

  /**
   * GETs a path on the metrics service and returns its parsed body untouched.
   *
   * @param path absolute path including the service's own /api prefix, e.g.
   * "/api/system".
   * @throws DashboardUpstreamError on a non-2xx, a transport failure, or the
   * 10 second timeout.
   */
  async function getJson(path: string): Promise<unknown> {
    // The timer is cleared in the finally below, which runs once fetch settles.
    // NOTE: that's before res.json() is read, so the timeout covers connecting
    // and headers but not a body that streams slowly.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      // Catches both a dead service and our own abort, which arrives here as an
      // AbortError. Either way there's no upstream status to pass on.
      const message =
        err instanceof Error ? err.message : "Dashboard request failed";
      throw new DashboardUpstreamError(message, 502);
    } finally {
      // Runs on the success path too, so a fast response doesn't leave a live
      // timer behind.
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new DashboardUpstreamError(
        `Dashboard ${path} failed (${res.status})`,
        res.status,
      );
    }

    return res.json();
  }

  return { getJson };
}

export type DashboardClient = ReturnType<typeof createDashboardClient>;
