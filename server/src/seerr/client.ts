// Typed HTTP client for Seerr, the request manager in the Overseerr and
// Jellyseerr family that feeds Radarr and Sonarr. Tyflix doesn't reimplement
// any of the request pipeline, so this one file is the whole integration:
// accounts, requests, quotas, quality profiles, the media table, watchlists,
// and issues.
//
// createSeerrClient() runs once in server/src/index.ts and the result is
// injected into the /api/auth, /api/me, /api/requests, /api/issues and
// /api/watchlist routers. Every call authenticates with the admin API key, so
// authorization is Tyflix's job and not Seerr's: routes check the session
// first, then call in here.
//
// Seerr encodes request and media state as small integers. The two lookup
// tables near the bottom of this file are the only place those numbers get
// names, and a code nobody recognizes is treated as an upstream failure rather
// than passed through as a mystery number.

import {
  issueTypeToCode,
  mapSeerrIssue,
  type IssueStatus,
  type IssueType,
  type IssueView,
} from "./issues";

// A Seerr account. Tyflix keys its own session off `id` (the Seerr user id) and
// matches Plex logins by `plexId`.
export type SeerrUser = {
  id: number;
  plexId: number;
  plexUsername: string;
  displayName: string;
  email: string | null;
  permissions: number; // Seerr's permission bitfield; bit 2 is admin (SEERR_ADMIN_BIT)
};

// The media record attached to a request. This is the join between the two id
// systems in the app: `tmdbId` is how discovery is keyed, `ratingKey` is how
// Plex is keyed, and Seerr is what holds them together.
export type SeerrMedia = {
  tmdbId: number;
  tvdbId: number | null; // mapped for completeness; nothing downstream reads it yet
  status: number; // MEDIA_STATUS code, not a label
  ratingKey: string | number | null; // Plex ratingKey; null means Seerr has no Plex match
  mediaType: string | null;
};

// Seerr's numeric media status after mediaStatusFromCode() has named it.
export type MediaAvailability =
  | "unknown"
  | "pending"
  | "processing"
  | "partially_available"
  | "available"
  | "blocklisted"
  | "deleted";

// A row from /api/v1/media, which is Seerr's table of everything it tracks.
// mediaStatusProvider turns a page of these into the tmdbId to ratingKey map
// that availability badges and playback both depend on.
export type SeerrMediaListItem = {
  id: number; // Seerr's own media id, needed when filing an issue
  tmdbId: number;
  mediaType: "movie" | "tv";
  status: number; // MEDIA_STATUS code
  ratingKey: string | null; // normalized to a string even when Seerr sends a number
};

// One title on a user's Plex Watchlist, as Seerr mirrors it.
export type SeerrWatchlistItem = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
};

// One half of a user's request quota. Movies and TV are counted separately.
export type QuotaAxis = {
  days: number; // rolling window the limit applies over
  limit: number; // 0 is unlimited; web/src/api/me.ts formatQuota() renders it that way
  used: number;
  restricted: boolean;
};

export type UserQuota = {
  movie: QuotaAxis;
  tv: QuotaAxis;
};

export type SeerrRequestSeason = {
  seasonNumber: number;
};

// A request as Seerr stores it. `status` and `media.status` are separate: a
// request can be approved while its media is still downloading.
export type SeerrRequest = {
  id: number;
  status: number;
  type: "movie" | "tv";
  media: SeerrMedia;
  seasons: SeerrRequestSeason[];
  createdAt: string;
  updatedAt: string;
  requestedBy: {
    id: number;
    displayName: string;
    plexUsername: string;
  };
};

// What the browser actually receives for a request: Seerr's row with the codes
// named and TMDB's title and poster folded in. Built by toRequestView().
export type RequestView = {
  id: number;
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string; // from TMDB, since Seerr's request row carries no title
  posterUrl: string | null;
  seasons: number[];
  requestStatus:
    | "pending"
    | "approved"
    | "declined"
    | "failed"
    | "completed";
  mediaStatus: MediaAvailability;
  requestedById: number;
  requestedByName: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateSeerrRequestInput = {
  mediaType: "movie" | "tv";
  tmdbId: number;
  seasons?: number[]; // TV only; omitted means Seerr decides the scope
  userId: number; // Seerr user id of the real requester, sent as X-API-User
  profileId?: number; // quality profile override, admin-only at the route layer
  serverId?: number; // required by Seerr whenever profileId is set
};

// The Radarr or Sonarr server Seerr will hand a request to, plus the quality
// profiles that server offers. Backs the admin profile picker.
export type ServiceProfiles = {
  serverId: number;
  defaultProfileId: number;
  profiles: Array<{ id: number; name: string }>;
};

export type CreateSeerrIssueInput = {
  issueType: IssueType;
  message: string;
  mediaId: number; // Seerr's media id, not a TMDB id
  userId: number;
  problemSeason?: number;
  problemEpisode?: number;
};

/**
 * Any failure talking to Seerr, whether Seerr answered badly or never answered.
 *
 * `status` is Seerr's own status code when there was a response, and 502 when
 * the fetch threw or the body didn't parse into the shape we expect. Routes
 * read it to decide what to send the browser: /api/requests turns a 409 into
 * "already requested", the auth router turns 401/403/422 into a 403.
 */
export class SeerrUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SeerrUpstreamError";
    this.status = status;
  }
}

export type SeerrClientOptions = {
  baseUrl: string; // no trailing slash; config strips it
  apiKey: string; // Seerr admin API key, sent as X-Api-Key on every call
};

// Bound on getUserById only (the per-request auth revalidation path). Mirrors
// dashboard/client.ts's AbortController pattern; 5000ms is the hardcoded cap
// for that lookup — short relative to the dashboard's 10s because auth sits on
// every authenticated request and median latency on the wire is ~6ms.
const GET_USER_BY_ID_TIMEOUT_MS = 5_000;

/**
 * Builds the Seerr client. One instance is created at startup and shared by
 * every router that needs Seerr.
 *
 * There's no retry and no cache in here on purpose. Caching lives one layer up
 * in mediaStatusProvider and the enrichment helper, which know how stale their
 * particular data is allowed to be.
 */
export function createSeerrClient(options: SeerrClientOptions) {
  const { baseUrl, apiKey } = options;

  // Single fetch chokepoint. Every Seerr call funnels through here so the API
  // key, JSON headers and error translation are written once.
  async function requestJson(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Api-Key": apiKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Seerr never answered (DNS, connection refused, container down). There's
      // no upstream status to forward, so call it a gateway failure.
      const message =
        err instanceof Error ? err.message : "Seerr request failed";
      throw new SeerrUpstreamError(message, 502);
    }

    // Seerr answered but refused. Keep its status so callers can distinguish a
    // 409 duplicate from a 403 permission problem from a 503 outage.
    if (!res.ok) {
      throw new SeerrUpstreamError(
        `Seerr ${path} failed (${res.status})`,
        res.status,
      );
    }

    return res.json();
  }

  function getJson(
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    return requestJson("GET", path, query);
  }

  function postJson(
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    return requestJson("POST", path, {}, body, extraHeaders);
  }

  /**
   * Signs a Plex token in to Seerr, which is how a household member gets a
   * Seerr account without me creating one by hand.
   *
   * Returns null on the normal path, because Seerr's success body isn't a
   * complete user (see the note below). Callers treat null as "carry on" and
   * look the account up with getUserByPlexId.
   *
   * @throws SeerrUpstreamError on any non-2xx. 401, 403 and 422 mean Seerr
   * refused the account, which the auth router turns into a 403.
   */
  async function signInWithPlex(authToken: string): Promise<SeerrUser | null> {
    // Seerr's own Plex sign-in (POST /api/v1/auth/plex). This onboards a
    // brand-new Plex-server member and, for existing users, refreshes their
    // stored Plex token so Watchlist syncing / auto-request keeps working.
    //
    // Verified against the live Jellyseerr instance (v3.3.0):
    //  - No X-Api-Key is required; the route is public and reads body.authToken.
    //    We reuse requestJson (which sends X-Api-Key) because the handler
    //    ignores req.user, so the header is harmless.
    //  - On success it returns the *filtered* user object, which OMITS plexId
    //    and email, so it is not a complete SeerrUser. We therefore map it and
    //    let a null result fall back to getUserByPlexId. Seerr saves the user
    //    synchronously before responding, so the follow-up lookup finds them.
    //  - A non-2xx surfaces as SeerrUpstreamError. Status 401/403/422 means
    //    Seerr refused the account (no Plex-server access); the caller maps
    //    that to a 403, while any other status stays a 502 upstream failure.
    //  - The success response also sets a connect.sid cookie, which we never
    //    read and never forward to the browser.
    const body = await postJson("/api/v1/auth/plex", { authToken });
    return mapSeerrUser(body);
  }

  /**
   * One Seerr account by Seerr user id (`GET /api/v1/user/:id`).
   *
   * Used by the per-request permission revalidation path. Unlike
   * getUserByPlexId this is a single targeted call, and unlike the rest of
   * this client it is bounded by GET_USER_BY_ID_TIMEOUT_MS (AbortController,
   * same shape as dashboard/client.ts).
   *
   * @returns null when Seerr answers 404 ("User not found.") — the account
   * no longer exists. Callers map that to 401; do not confuse it with a
   * transport failure.
   * @throws SeerrUpstreamError on timeout, network failure, non-404 error
   * status, or an unmappable 200 body.
   */
  async function getUserById(id: number): Promise<SeerrUser | null> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      GET_USER_BY_ID_TIMEOUT_MS,
    );
    const path = `/api/v1/user/${id}`;

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: {
          "X-Api-Key": apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      // Dead Seerr and our own abort both land here as a thrown fetch error.
      const message =
        err instanceof Error ? err.message : "Seerr request failed";
      throw new SeerrUpstreamError(message, 502);
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      throw new SeerrUpstreamError(
        `Seerr ${path} failed (${res.status})`,
        res.status,
      );
    }

    const body: unknown = await res.json();
    const mapped = mapSeerrUser(body);
    if (mapped === null) {
      throw new SeerrUpstreamError(
        "Seerr getUserById returned unexpected body",
        502,
      );
    }
    return mapped;
  }

  /**
   * Finds the Seerr account belonging to a Plex user id.
   *
   * This is the bridge from "who just logged in with Plex" to "which Seerr user
   * am I acting as", and the answer goes straight into the session. There's no
   * filter-by-plexId call in use here, so it walks the paged user list and
   * matches locally, returning as soon as it hits.
   *
   * @returns null when no Seerr account carries that plexId.
   * @throws SeerrUpstreamError on a bad status or a body that isn't a page.
   */
  async function getUserByPlexId(plexId: number): Promise<SeerrUser | null> {
    const take = 100;
    let skip = 0;
    // Start at infinity so the loop always makes its first call, then let
    // pageInfo.results tell us where the real end is.
    let total = Number.POSITIVE_INFINITY;

    while (skip < total) {
      const body = await getJson("/api/v1/user", {
        take: String(take),
        skip: String(skip),
      });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          "Seerr getUserByPlexId returned unexpected body",
          502,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          "Seerr getUserByPlexId returned unexpected pageInfo",
          502,
        );
      }

      total = pageInfo.results;
      const results = (body as { results: unknown[] }).results;

      for (const row of results) {
        const mapped = mapSeerrUser(row);
        if (mapped !== null && mapped.plexId === plexId) {
          return mapped;
        }
      }

      // Guard against a page count that never lines up with what's actually
      // returned. Without this an over-reported total spins forever.
      if (results.length === 0) {
        break;
      }
      skip += take;
    }

    return null;
  }

  // Shared pager for the two request endpoints (everyone's, and one user's).
  // Both return the same {pageInfo, results} envelope, so the walking and the
  // shape checks only need writing once.
  async function listRequests(
    path: string,
    query: Record<string, string> = {},
  ): Promise<SeerrRequest[]> {
    const take = 100;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    const requests: SeerrRequest[] = [];

    while (skip < total) {
      const body = await getJson(path, {
        take: String(take),
        skip: String(skip),
        ...query,
      });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          `Seerr ${path} returned unexpected body`,
          502,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          `Seerr ${path} returned unexpected pageInfo`,
          502,
        );
      }

      total = pageInfo.results;
      const results = (body as { results: unknown[] }).results;

      for (const row of results) {
        const mapped = mapSeerrRequest(row);
        if (mapped === null) {
          // One malformed request must not fail the whole list.
          console.warn(`Seerr ${path} returned an unmappable request; skipping`);
          continue;
        }
        requests.push(mapped);
      }

      if (results.length === 0) {
        break;
      }
      skip += take;
    }

    return requests;
  }

  /**
   * Every request on the server, oldest first. Admin surfaces only.
   *
   * @throws SeerrUpstreamError on a bad status or an unexpected page shape.
   */
  function listAllRequests(): Promise<SeerrRequest[]> {
    return listRequests("/api/v1/request", { sort: "added" });
  }

  /**
   * One user's requests. Feeds both the user's own requests page and the
   * watched-versus-requested analytics on Home.
   *
   * @throws SeerrUpstreamError on a bad status or an unexpected page shape.
   */
  function listUserRequests(userId: number): Promise<SeerrRequest[]> {
    return listRequests(`/api/v1/user/${userId}/requests`);
  }

  /**
   * A user's remaining movie and TV request allowance.
   *
   * @throws SeerrUpstreamError when either axis is missing or malformed. Both
   * have to be usable, since a half-known quota would be shown as a real one.
   */
  async function getUserQuota(userId: number): Promise<UserQuota> {
    const body = await getJson(`/api/v1/user/${userId}/quota`);
    if (typeof body !== "object" || body === null) {
      throw new SeerrUpstreamError(
        "Seerr getUserQuota returned unexpected body",
        502,
      );
    }

    const movie = mapQuotaAxis((body as { movie?: unknown }).movie);
    const tv = mapQuotaAxis((body as { tv?: unknown }).tv);
    if (movie === null || tv === null) {
      throw new SeerrUpstreamError(
        "Seerr getUserQuota returned unexpected body",
        502,
      );
    }

    return { movie, tv };
  }

  /**
   * Quality profiles available for a media type, plus the server they belong
   * to. Radarr handles movies, Sonarr handles TV.
   *
   * Two round trips: the server list doesn't carry profiles, so pick a server
   * and then ask for its detail. Seerr requires a serverId alongside any
   * profileId override, which is why the chosen id is returned too.
   *
   * @throws SeerrUpstreamError when the server list is empty or either
   * response is shaped differently than expected.
   */
  async function getServiceProfiles(
    mediaType: "movie" | "tv",
  ): Promise<ServiceProfiles> {
    const service = mediaType === "movie" ? "radarr" : "sonarr";
    const serversBody = await getJson(`/api/v1/service/${service}`);
    if (!Array.isArray(serversBody) || serversBody.length === 0) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected server list",
        502,
      );
    }

    const servers = serversBody.map(mapServiceServer);
    if (servers.some((server) => server === null)) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected server list",
        502,
      );
    }
    const validServers = servers as Array<{ id: number; isDefault: boolean }>;
    // Prefer whichever server Seerr marks default. Nothing marked? Take the
    // first one rather than failing, which is what a single-server setup with
    // isDefault unset looks like.
    const selected =
      validServers.find((server) => server.isDefault) ?? validServers[0];

    const detailBody = await getJson(
      `/api/v1/service/${service}/${selected.id}`,
    );
    if (typeof detailBody !== "object" || detailBody === null) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected service detail",
        502,
      );
    }

    const server = (detailBody as { server?: unknown }).server;
    const profilesBody = (detailBody as { profiles?: unknown }).profiles;
    if (
      typeof server !== "object" ||
      server === null ||
      !Array.isArray(profilesBody)
    ) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected service detail",
        502,
      );
    }

    // Seerr calls the currently selected profile activeProfileId; the UI shows
    // it as the default choice.
    const defaultProfileId = (server as { activeProfileId?: unknown })
      .activeProfileId;
    const profiles = profilesBody.map(mapServiceProfile);
    if (
      typeof defaultProfileId !== "number" ||
      !Number.isFinite(defaultProfileId) ||
      profiles.some((profile) => profile === null)
    ) {
      throw new SeerrUpstreamError(
        "Seerr getServiceProfiles returned unexpected service detail",
        502,
      );
    }

    return {
      serverId: selected.id,
      defaultProfileId,
      profiles: profiles as Array<{ id: number; name: string }>,
    };
  }

  /**
   * Everything Seerr tracks, one row per title. This is the raw material for
   * the TMDB-id to Plex-ratingKey join that mediaStatusProvider caches.
   *
   * Rows that don't map cleanly are dropped rather than fatal, since one weird
   * record shouldn't blank out availability for the whole library. The paging
   * cost is why the caller caches instead of calling this per request.
   *
   * @throws SeerrUpstreamError on a bad status or an unexpected page shape.
   */
  async function listMedia(): Promise<SeerrMediaListItem[]> {
    const take = 100;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    const media: SeerrMediaListItem[] = [];

    while (skip < total) {
      const body = await getJson("/api/v1/media", {
        take: String(take),
        skip: String(skip),
      });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          "Seerr /api/v1/media returned unexpected body",
          502,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          "Seerr /api/v1/media returned unexpected pageInfo",
          502,
        );
      }

      total = pageInfo.results;
      const results = (body as { results: unknown[] }).results;
      for (const row of results) {
        const mapped = mapSeerrMediaListItem(row);
        if (mapped !== null) {
          media.push(mapped);
        }
      }

      if (results.length === 0) {
        break;
      }
      skip += take;
    }

    return media;
  }

  /**
   * A user's Plex Watchlist as Seerr mirrors it.
   *
   * Note the pagination here is page-based with a totalPages field, not the
   * take/skip envelope the rest of the API uses, so this one gets its own loop.
   *
   * @param page first page to fetch; everything from there on is walked.
   * @throws SeerrUpstreamError on a bad status or an unexpected page shape.
   */
  async function listUserWatchlist(
    userId: number,
    page = 1,
  ): Promise<SeerrWatchlistItem[]> {
    let currentPage = page;
    let totalPages = currentPage;
    const watchlist: SeerrWatchlistItem[] = [];

    do {
      const path = `/api/v1/user/${userId}/watchlist`;
      const body = await getJson(path, { page: String(currentPage) });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { totalPages?: unknown }).totalPages !== "number" ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          `Seerr ${path} returned unexpected body`,
          502,
        );
      }

      totalPages = (body as { totalPages: number }).totalPages;
      const results = (body as { results: unknown[] }).results;
      for (const row of results) {
        const mapped = mapSeerrWatchlistItem(row);
        if (mapped !== null) {
          watchlist.push(mapped);
        }
      }
      currentPage += 1;
    } while (currentPage <= totalPages);

    return watchlist;
  }

  /**
   * Every issue on the server, open and resolved alike.
   *
   * There's no per-user variant: the issues router pulls the whole list and
   * filters on createdBy, so a normal user sees only their own reports and an
   * admin sees all of them.
   *
   * @throws SeerrUpstreamError on a bad status or an unexpected page shape.
   */
  async function listIssues(): Promise<IssueView[]> {
    const take = 100;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    const issues: IssueView[] = [];

    while (skip < total) {
      // filter=all is explicit because the UI has to show a report through to
      // its resolution, so resolved issues must come back too. The test pins
      // both that param and the resolved row it returns.
      const body = await getJson("/api/v1/issue", {
        take: String(take),
        skip: String(skip),
        sort: "added",
        filter: "all",
      });

      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { pageInfo?: unknown }).pageInfo !== "object" ||
        (body as { pageInfo: unknown }).pageInfo === null ||
        !Array.isArray((body as { results?: unknown }).results)
      ) {
        throw new SeerrUpstreamError(
          "Seerr /api/v1/issue returned unexpected body",
          502,
        );
      }

      const pageInfo = (body as { pageInfo: { results?: unknown } }).pageInfo;
      if (typeof pageInfo.results !== "number") {
        throw new SeerrUpstreamError(
          "Seerr /api/v1/issue returned unexpected pageInfo",
          502,
        );
      }

      total = pageInfo.results;
      const results = (body as { results: unknown[] }).results;
      for (const row of results) {
        const mapped = mapSeerrIssue(row);
        if (mapped !== null) {
          issues.push(mapped);
        }
      }

      if (results.length === 0) {
        break;
      }
      skip += take;
    }

    return issues;
  }

  /**
   * One issue with its comment thread.
   *
   * @throws SeerrUpstreamError on a bad status, including the 404 for an id
   * that doesn't exist, or when the body doesn't map to an issue.
   */
  async function getIssue(id: number): Promise<IssueView> {
    const body = await getJson(`/api/v1/issue/${id}`);
    return requireSeerrIssue(body, "getIssue");
  }

  /**
   * Files a "report a problem" against a title.
   *
   * `mediaId` is Seerr's own media id rather than a TMDB id, which is why the
   * issues router resolves it through mediaStatusProvider first and 404s when
   * Seerr isn't tracking the title at all.
   *
   * @throws SeerrUpstreamError on a bad status or an unmappable body.
   */
  async function createIssue(
    input: CreateSeerrIssueInput,
  ): Promise<IssueView> {
    const body = await postJson("/api/v1/issue", {
      issueType: issueTypeToCode(input.issueType),
      message: input.message,
      mediaId: input.mediaId,
      userId: input.userId,
      ...(input.problemSeason === undefined
        ? {}
        : { problemSeason: input.problemSeason }),
      ...(input.problemEpisode === undefined
        ? {}
        : { problemEpisode: input.problemEpisode }),
    });
    return requireSeerrIssue(body, "createIssue");
  }

  /**
   * Adds a comment to an issue thread and returns the updated issue.
   *
   * Unlike createIssue there's no requester field here, so the comment carries
   * whatever identity the API key resolves to. routes/issues.ts already has a
   * TODO on that attribution gap; the caller still does its own ownership check
   * before letting anyone comment.
   *
   * @throws SeerrUpstreamError on a bad status or an unmappable body.
   */
  async function addIssueComment(
    issueId: number,
    message: string,
  ): Promise<IssueView> {
    const body = await postJson(`/api/v1/issue/${issueId}/comment`, {
      message,
    });
    return requireSeerrIssue(body, "addIssueComment");
  }

  /**
   * Opens or resolves an issue. The status is the last path segment, so
   * "resolved" posts to /api/v1/issue/{id}/resolved.
   *
   * @throws SeerrUpstreamError on a bad status or an unmappable body.
   */
  async function setIssueStatus(
    issueId: number,
    status: IssueStatus,
  ): Promise<IssueView> {
    const body = await postJson(`/api/v1/issue/${issueId}/${status}`);
    return requireSeerrIssue(body, "setIssueStatus");
  }

  /**
   * Creates a request, which is what actually sends a title down the Radarr or
   * Sonarr pipeline.
   *
   * Read the note below before touching this. The X-API-User header is what
   * makes the request belong to the person who clicked the button; drop it and
   * every household request comes back approved as the admin. That bug shipped
   * once (fixed in 51d06b3) and the tests now assert the header.
   *
   * Two naming traps in the request body: Seerr calls the TMDB id `mediaId`,
   * and `seasons` only applies to TV.
   *
   * @throws Error when userId isn't a positive integer, before any network
   * call, because a missing requester is a programming mistake and not an
   * upstream problem.
   * @throws SeerrUpstreamError on a bad status. 409 means Seerr already has
   * this request and the route turns it into "already requested".
   */
  async function createRequest(
    input: CreateSeerrRequestInput,
  ): Promise<SeerrRequest> {
    // Seerr resolves API-key auth to user ID 1 (the original admin) unless the
    // caller also sends X-API-User. Auto-approve decisions and modifiedBy are
    // based on that authenticated req.user — not on a body userId field, which
    // Seerr only uses for attribution/quota when the caller already has
    // MANAGE_USERS / MANAGE_REQUESTS. Relying on body userId alone (or omitting
    // X-API-User) silently reverts every household request to admin auto-approve.
    if (!Number.isInteger(input.userId) || input.userId <= 0) {
      throw new Error(
        `createRequest requires a positive integer userId (got ${String(input.userId)})`,
      );
    }

    const body = await postJson(
      "/api/v1/request",
      {
        mediaType: input.mediaType,
        mediaId: input.tmdbId,
        ...(input.mediaType === "tv" && input.seasons !== undefined
          ? { seasons: input.seasons }
          : {}),
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
      },
      { "X-API-User": String(input.userId) },
    );
    return requireSeerrRequest(body, "createRequest");
  }

  /**
   * Approves a pending request. Admin-gated at the route.
   *
   * @throws SeerrUpstreamError on a bad status or an unmappable body.
   */
  async function approveRequest(id: number): Promise<SeerrRequest> {
    const body = await postJson(`/api/v1/request/${id}/approve`);
    return requireSeerrRequest(body, "approveRequest");
  }

  /**
   * Declines a pending request. Admin-gated at the route.
   *
   * @throws SeerrUpstreamError on a bad status or an unmappable body.
   */
  async function declineRequest(id: number): Promise<SeerrRequest> {
    const body = await postJson(`/api/v1/request/${id}/decline`);
    return requireSeerrRequest(body, "declineRequest");
  }

  return {
    signInWithPlex,
    getUserById,
    getUserByPlexId,
    listAllRequests,
    listUserRequests,
    // Two names for one function: routes/me.ts reads it as getRequestsByUser,
    // routes/requests.ts as listUserRequests.
    getRequestsByUser: listUserRequests,
    getUserQuota,
    getServiceProfiles,
    listMedia,
    listUserWatchlist,
    listIssues,
    getIssue,
    createIssue,
    addIssueComment,
    setIssueStatus,
    createRequest,
    approveRequest,
    declineRequest,
  };
}

export type SeerrClient = ReturnType<typeof createSeerrClient>;

// Seerr's numeric enums, named. Routers deal in these labels only, so if Seerr
// ever renumbers, this is the single place that has to change.
const REQUEST_STATUS = {
  1: "pending",
  2: "approved",
  3: "declined",
  4: "failed",
  5: "completed",
} as const;

const MEDIA_STATUS = {
  1: "unknown",
  2: "pending",
  3: "processing",
  4: "partially_available", // some seasons or episodes present, the amber badge
  5: "available",
  6: "blocklisted",
  7: "deleted",
} as const;

/**
 * Names a Seerr media status code.
 *
 * @returns null for a code that isn't in the table, which callers treat as an
 * upstream problem rather than guessing at availability.
 */
export function mediaStatusFromCode(code: number): MediaAvailability | null {
  return MEDIA_STATUS[code as keyof typeof MEDIA_STATUS] ?? null;
}

/**
 * Turns a Seerr request into the shape the browser gets: codes named, seasons
 * flattened to plain numbers, and the title and poster supplied by the caller.
 *
 * Seerr's request rows carry no title, so the requests router looks each one up
 * in TMDB and passes the result in as `details`.
 *
 * @throws SeerrUpstreamError when either status code is unrecognized. Failing
 * beats rendering a request whose state nobody can name.
 */
export function toRequestView(
  req: SeerrRequest,
  details: { title: string; posterUrl: string | null },
): RequestView {
  const requestStatus = REQUEST_STATUS[req.status as keyof typeof REQUEST_STATUS];
  const mediaStatus = mediaStatusFromCode(req.media.status);
  if (requestStatus === undefined || mediaStatus === null) {
    throw new SeerrUpstreamError("Seerr request returned an unknown status", 502);
  }

  return {
    id: req.id,
    tmdbId: req.media.tmdbId,
    mediaType: req.type,
    title: details.title,
    posterUrl: details.posterUrl,
    seasons: req.seasons.map((season) => season.seasonNumber),
    requestStatus,
    mediaStatus,
    requestedById: req.requestedBy.id,
    // An empty displayName falls back to the Plex username, so the requester
    // column never renders blank.
    requestedByName:
      req.requestedBy.displayName || req.requestedBy.plexUsername,
    createdAt: req.createdAt,
    updatedAt: req.updatedAt,
  };
}

// Everything below is defensive parsing. Seerr's responses arrive as `unknown`
// and each mapper returns null instead of throwing, which lets the list callers
// drop one bad row and keep the rest. The require* wrappers at the very bottom
// are for single-object endpoints, where null really is a failure.

// Validates a /api/v1/media row. Anything that isn't a movie or a show gets
// dropped, so people rows never reach the status map.
function mapSeerrMediaListItem(row: unknown): SeerrMediaListItem | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  const tmdbId = (row as { tmdbId?: unknown }).tmdbId;
  const mediaType = (row as { mediaType?: unknown }).mediaType;
  const status = (row as { status?: unknown }).status;
  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    typeof tmdbId !== "number" ||
    !Number.isFinite(tmdbId) ||
    (mediaType !== "movie" && mediaType !== "tv") ||
    typeof status !== "number" ||
    !Number.isFinite(status)
  ) {
    return null;
  }

  // ratingKey is best-effort: a missing/odd value must not drop the item.
  const ratingKeyRaw = (row as { ratingKey?: unknown }).ratingKey;
  const ratingKey =
    typeof ratingKeyRaw === "string"
      ? ratingKeyRaw
      : typeof ratingKeyRaw === "number"
        ? String(ratingKeyRaw)
        : null;

  return { id, tmdbId, mediaType, status, ratingKey };
}

// A watchlist row is only useful with a TMDB id and a media type we can browse,
// so anything else is skipped.
function mapSeerrWatchlistItem(row: unknown): SeerrWatchlistItem | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const tmdbId = (row as { tmdbId?: unknown }).tmdbId;
  const mediaType = (row as { mediaType?: unknown }).mediaType;
  const title = (row as { title?: unknown }).title;
  if (
    typeof tmdbId !== "number" ||
    !Number.isFinite(tmdbId) ||
    (mediaType !== "movie" && mediaType !== "tv") ||
    typeof title !== "string"
  ) {
    return null;
  }

  return { tmdbId, mediaType, title };
}

// One quota axis. Every field has to be present: a partially parsed quota would
// be displayed as if it were real, so the caller escalates a null to a 502.
function mapQuotaAxis(row: unknown): QuotaAxis | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const days = (row as { days?: unknown }).days;
  const limit = (row as { limit?: unknown }).limit;
  const used = (row as { used?: unknown }).used;
  const restricted = (row as { restricted?: unknown }).restricted;
  if (
    typeof days !== "number" ||
    !Number.isFinite(days) ||
    typeof limit !== "number" ||
    !Number.isFinite(limit) ||
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    typeof restricted !== "boolean"
  ) {
    return null;
  }

  return { days, limit, used, restricted };
}

// Just the two fields getServiceProfiles needs to choose a Radarr or Sonarr
// server. The rest of the row is ignored.
function mapServiceServer(
  row: unknown,
): { id: number; isDefault: boolean } | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const id = (row as { id?: unknown }).id;
  const isDefault = (row as { isDefault?: unknown }).isDefault;
  if (
    typeof id !== "number" ||
    !Number.isFinite(id) ||
    typeof isDefault !== "boolean"
  ) {
    return null;
  }
  return { id, isDefault };
}

// A quality profile is only an id and a label as far as Tyflix is concerned.
function mapServiceProfile(
  row: unknown,
): { id: number; name: string } | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const id = (row as { id?: unknown }).id;
  const name = (row as { name?: unknown }).name;
  if (typeof id !== "number" || !Number.isFinite(id) || typeof name !== "string") {
    return null;
  }
  return { id, name };
}

// Validates a Seerr account row. plexId is required, which is what makes
// signInWithPlex return null: Seerr's sign-in body leaves plexId out, so it
// can't produce a complete user and the caller has to look one up instead.
// email is optional and normalized to null.
function mapSeerrUser(row: unknown): SeerrUser | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  const plexId = (row as { plexId?: unknown }).plexId;
  const plexUsername = (row as { plexUsername?: unknown }).plexUsername;
  const displayName = (row as { displayName?: unknown }).displayName;
  const email = (row as { email?: unknown }).email;
  const permissions = (row as { permissions?: unknown }).permissions;

  if (
    typeof id !== "number" ||
    typeof plexId !== "number" ||
    typeof plexUsername !== "string" ||
    typeof displayName !== "string" ||
    typeof permissions !== "number"
  ) {
    return null;
  }

  return {
    id,
    plexId,
    plexUsername,
    displayName,
    email: typeof email === "string" ? email : null,
    permissions,
  };
}

// The biggest mapper here, because a request is the most nested thing Seerr
// returns. Identity and status fields are mandatory; optional ones degrade to a
// default, so a missing updatedAt falls back to createdAt and a missing seasons
// array becomes empty. A ratingKey of some unexpected type rejects the whole
// row, which is stricter than mapSeerrMediaListItem, where an odd ratingKey
// only nulls that one field.
function mapSeerrRequest(row: unknown): SeerrRequest | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }

  const id = (row as { id?: unknown }).id;
  const requestStatus = (row as { status?: unknown }).status;
  const type = (row as { type?: unknown }).type;
  const createdAt = (row as { createdAt?: unknown }).createdAt;
  const updatedAtRaw = (row as { updatedAt?: unknown }).updatedAt;
  const mediaRaw = (row as { media?: unknown }).media;
  const requestedByRaw = (row as { requestedBy?: unknown }).requestedBy;
  const seasonsRaw = (row as { seasons?: unknown }).seasons;

  if (
    typeof id !== "number" ||
    typeof requestStatus !== "number" ||
    (type !== "movie" && type !== "tv")
  ) {
    return null;
  }
  if (typeof createdAt !== "string") {
    return null;
  }
  const updatedAt =
    typeof updatedAtRaw === "string" ? updatedAtRaw : createdAt;
  if (typeof mediaRaw !== "object" || mediaRaw === null) {
    return null;
  }
  if (typeof requestedByRaw !== "object" || requestedByRaw === null) {
    return null;
  }

  const requestedById = (requestedByRaw as { id?: unknown }).id;
  const displayName = (requestedByRaw as { displayName?: unknown }).displayName;
  const plexUsername = (requestedByRaw as { plexUsername?: unknown }).plexUsername;
  if (
    typeof requestedById !== "number" ||
    typeof displayName !== "string" ||
    typeof plexUsername !== "string"
  ) {
    return null;
  }

  const mediaStatus = (mediaRaw as { status?: unknown }).status;
  const tmdbId = (mediaRaw as { tmdbId?: unknown }).tmdbId;
  const tvdbIdRaw = (mediaRaw as { tvdbId?: unknown }).tvdbId;
  if (
    typeof mediaStatus !== "number" ||
    typeof tmdbId !== "number" ||
    (typeof tvdbIdRaw !== "number" &&
      tvdbIdRaw !== null &&
      tvdbIdRaw !== undefined)
  ) {
    return null;
  }

  const ratingKeyRaw = (mediaRaw as { ratingKey?: unknown }).ratingKey;
  let ratingKey: string | number | null = null;
  if (typeof ratingKeyRaw === "string" || typeof ratingKeyRaw === "number") {
    ratingKey = ratingKeyRaw;
  } else if (ratingKeyRaw === null || ratingKeyRaw === undefined) {
    ratingKey = null;
  } else {
    return null;
  }

  const mediaTypeRaw = (mediaRaw as { mediaType?: unknown }).mediaType;
  const mediaType = typeof mediaTypeRaw === "string" ? mediaTypeRaw : null;

  const seasons: SeerrRequestSeason[] = [];
  if (Array.isArray(seasonsRaw)) {
    for (const season of seasonsRaw) {
      if (typeof season !== "object" || season === null) {
        continue;
      }
      const seasonNumber = (season as { seasonNumber?: unknown }).seasonNumber;
      if (typeof seasonNumber === "number") {
        seasons.push({ seasonNumber });
      }
    }
  }

  return {
    id,
    status: requestStatus,
    type,
    createdAt,
    updatedAt,
    media: {
      tmdbId,
      tvdbId: typeof tvdbIdRaw === "number" ? tvdbIdRaw : null,
      status: mediaStatus,
      ratingKey,
      mediaType,
    },
    seasons,
    requestedBy: {
      id: requestedById,
      displayName,
      plexUsername,
    },
  };
}

// For the single-object endpoints. Nothing to skip past, so an unmappable body
// is a 502 with the operation name baked into the message.
function requireSeerrRequest(body: unknown, operation: string): SeerrRequest {
  const request = mapSeerrRequest(body);
  if (request === null) {
    throw new SeerrUpstreamError(
      `Seerr ${operation} returned unexpected body`,
      502,
    );
  }
  return request;
}

// Same idea as requireSeerrRequest, for the four issue endpoints.
function requireSeerrIssue(body: unknown, operation: string): IssueView {
  const issue = mapSeerrIssue(body);
  if (issue === null) {
    throw new SeerrUpstreamError(
      `Seerr ${operation} returned unexpected body`,
      502,
    );
  }
  return issue;
}
