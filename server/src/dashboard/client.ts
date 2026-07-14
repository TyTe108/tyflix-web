export class DashboardUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DashboardUpstreamError";
    this.status = status;
  }
}

export type DashboardClientOptions = {
  baseUrl: string;
};

const REQUEST_TIMEOUT_MS = 10_000;

export function createDashboardClient(options: DashboardClientOptions) {
  const { baseUrl } = options;

  async function getJson(path: string): Promise<unknown> {
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
      const message =
        err instanceof Error ? err.message : "Dashboard request failed";
      throw new DashboardUpstreamError(message, 502);
    } finally {
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
