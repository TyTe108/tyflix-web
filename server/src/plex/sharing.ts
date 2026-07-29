// Plex library-sharing client: resolve machine id, list shareable sections,
// send invites, and read invite/acceptance state. Matches the closure-factory
// + regex-XML style of sharedServerAccess.ts.
//
// Overlaps with sharedServerAccess's private fetchMachineIdentifier — accept
// that duplication for now; do not refactor a shared helper out of the
// playback-critical path in the same increment as this feature.
//
// ⚠️ inviteToServer POSTs a real invitation email. Never call it against a
// live plex.tv from tests or ad-hoc scripts — always inject a fake fetch.
//
// This is what makes self-serve access real. A stranger fills in the form at
// /request-access, that lands as a pending row, and approving it calls
// inviteToServer to turn the row into an actual Plex library invite.
// routes/adminAccessRequests.ts is the only caller. It also reads
// listPendingInvites and listShares on every list request to reconcile the
// local queue against plex.tv, so someone who got access another way stops
// showing up as pending.
//
// Everything here is owner-scoped and admin-gated. No user token, no session,
// nothing a signed-in non-admin can reach.

/**
 * Thrown for any sharing failure.
 *
 * `status` is the upstream HTTP status where there was one, 400 for the local
 * sectionIds guard, and 502 by default. routes/adminAccessRequests.ts answers
 * with that status verbatim, so whatever goes in here is what the admin UI
 * sees.
 */
export class PlexSharingError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "PlexSharingError";
    this.status = status;
  }
}

// All from config. Sharing is an owner action, so there's no user token here.
export type PlexSharingClientOptions = {
  // LAN URL of our PMS, e.g. http://10.0.0.10:32400 (config.plexBaseUrl).
  baseUrl: string;
  // Owner/server token used against /identity and plex.tv (config.plexToken).
  ownerToken: string;
  // X-Plex-Client-Identifier (config.plexClientId).
  clientId: string;
};

/**
 * A library section as plex.tv's sharing API sees it.
 *
 * `id` is the plex.tv sharing section id (often 9 digits). That is what
 * `inviteToServer` must pass in `library_section_ids`.
 *
 * `key` is the local PMS section key (1, 2, …) used everywhere else in this
 * codebase. Passing `key` values into inviteToServer silently shares the
 * wrong thing.
 */
export type ShareableSection = {
  id: number;
  key: number;
  title: string;
  type: string;
};

/**
 * A pending "Library Request Sent" invite from plex.tv.
 *
 * `id` is a string because plex.tv uses two shapes (observed 2026-07-27):
 *   - Invitee WITH a Plex account: numeric id, e.g. id="60318749" username="schr465"
 *   - Invitee WITHOUT a Plex account: id is the email itself, username=""
 *     e.g. id="someone@example.com" username=""
 * Do not coerce to number — that silently drops the no-account case this feature
 * creates most often.
 */
export type PendingInvite = {
  id: string;
  email: string;
  username: string;
  createdAt: number;
};

/**
 * An existing share on our server, from plex.tv's shared_servers list.
 *
 * A row here means the invite was sent. `acceptedAt` is what separates "they
 * clicked the link" from "still waiting", and the reconciler in
 * routes/adminAccessRequests.ts keys on exactly that.
 */
export type SharedServerShare = {
  userId: number; // plexId, the same number sharedServerAccess.ts maps on
  username: string;
  email: string;
  invitedAt: number | null; // epoch seconds, null when absent or "0"
  acceptedAt: number | null; // epoch seconds; null means not accepted yet
  allLibraries: boolean; // mirrors allLibraries="1" on the tag
};

/**
 * Outcome of an invite attempt.
 *
 * alreadyShared isn't a failure. It comes back when plex.tv says this email is
 * already on the server, which is a fine end state for an approval, so the
 * admin route records the row as invited and notes it.
 */
export type InviteResult =
  | { ok: true }
  | { ok: false; reason: "alreadyShared" };

/**
 * Builds the sharing client. Created lazily in index.ts, and only when
 * ACCESS_REQUESTS_FILE is set, so the whole feature is off by default.
 */
export function createPlexSharingClient(options: PlexSharingClientOptions) {
  const { baseUrl, ownerToken, clientId } = options;
  // Cached for the life of the process, no TTL. The two resolvers next door
  // expire theirs after ten minutes; this one is only read on admin actions.
  let cachedMachineId: string | null = null;

  // Our server's plex.tv machine id, which every URL below is keyed on.
  async function resolveMachineId(): Promise<string> {
    if (cachedMachineId !== null) {
      return cachedMachineId;
    }

    const body = await getJson(`${baseUrl}/identity`, {
      "X-Plex-Token": ownerToken,
      Accept: "application/json",
    });

    const container =
      typeof body === "object" && body !== null
        ? (body as { MediaContainer?: unknown }).MediaContainer
        : null;
    const machineIdentifier =
      typeof container === "object" && container !== null
        ? (container as { machineIdentifier?: unknown }).machineIdentifier
        : undefined;

    if (typeof machineIdentifier !== "string" || machineIdentifier === "") {
      throw new PlexSharingError(
        "Plex /identity returned no machineIdentifier",
      );
    }

    cachedMachineId = machineIdentifier;
    return machineIdentifier;
  }

  // Libraries this server can share, as plex.tv numbers them. The admin UI
  // renders these as checkboxes, and the approve route uses them as the
  // allowlist for whatever the admin ticked.
  async function listShareableSections(): Promise<ShareableSection[]> {
    const machineId = await resolveMachineId();
    const url = `https://plex.tv/api/servers/${machineId}`;
    const xml = await getText(url, plexTvHeaders());
    return parseShareableSections(xml);
  }

  // Sends a real library invite. This is the one call in the file with a side
  // effect a stranger can see, so treat it accordingly.
  async function inviteToServer(input: {
    email: string;
    sectionIds: number[];
  }): Promise<InviteResult> {
    // Validate before anything hits the network. The tests assert that an empty
    // or non-integer list never even resolves the machine id.
    validateSectionIds(input.sectionIds);

    const machineId = await resolveMachineId();
    const url = `https://plex.tv/api/servers/${machineId}/shared_servers`;
    const body = {
      server_id: machineId,
      shared_server: {
        library_section_ids: input.sectionIds,
        invited_email: input.email,
      },
      // Least-privilege share: sync (downloads), camera upload, and channels
      // all off, content filters sent empty. Same payload for every invite;
      // the only thing the admin picks is which libraries.
      sharing_settings: {
        allowSync: "0",
        allowCameraUpload: "0",
        allowChannels: "0",
        filterMovies: "",
        filterTelevision: "",
        filterMusic: "",
      },
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          ...plexTvHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw networkError(err);
    }

    if (res.ok) {
      return { ok: true };
    }

    // 422 is ambiguous on its own, so read the body before deciding. Only the
    // 1999 code means "already shared"; any other 422 is a genuine failure.
    if (res.status === 422) {
      let text = "";
      try {
        text = await res.text();
      } catch {
        // fall through to generic throw
      }
      // Plex returns <error code="1999"/> when the email/username is already shared.
      if (text.includes('<error code="1999"')) {
        return { ok: false, reason: "alreadyShared" };
      }
    }

    throw new PlexSharingError(
      `Plex request ${url} failed (${res.status})`,
      res.status,
    );
  }

  // Invites that have gone out and haven't been accepted yet. This URL carries
  // no machine id, unlike everything else in the file.
  async function listPendingInvites(): Promise<PendingInvite[]> {
    const url = "https://plex.tv/api/invites/requested";
    const xml = await getText(url, plexTvHeaders());
    return parsePendingInvites(xml);
  }

  // Everyone our server is shared with, accepted or not. Paired with
  // listPendingInvites to work out which local rows plex.tv has moved on from.
  async function listShares(): Promise<SharedServerShare[]> {
    const machineId = await resolveMachineId();
    const url = `https://plex.tv/api/servers/${machineId}/shared_servers`;
    const xml = await getText(url, plexTvHeaders());
    return parseShares(xml);
  }

  // Owner auth for every plex.tv call in this file.
  function plexTvHeaders(): Record<string, string> {
    return {
      "X-Plex-Token": ownerToken,
      "X-Plex-Client-Identifier": clientId,
    };
  }

  // JSON reader, used only by /identity. Carries the upstream status onto the
  // error so the admin route can answer with it.
  async function getJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers });
    } catch (err) {
      throw networkError(err);
    }

    if (!res.ok) {
      throw new PlexSharingError(
        `Plex request ${url} failed (${res.status})`,
        res.status,
      );
    }

    return res.json();
  }

  // Raw-body reader for the three plex.tv endpoints this file parses as XML.
  // Same error handling as getJson, different body read.
  async function getText(
    url: string,
    headers: Record<string, string>,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers });
    } catch (err) {
      throw networkError(err);
    }

    if (!res.ok) {
      throw new PlexSharingError(
        `Plex request ${url} failed (${res.status})`,
        res.status,
      );
    }

    return res.text();
  }

  return {
    resolveMachineId,
    listShareableSections,
    inviteToServer,
    listPendingInvites,
    listShares,
  };
}

// routes/adminAccessRequests.ts takes a Pick<> of this, so its tests only have
// to stub the four methods it actually calls.
export type PlexSharingClient = ReturnType<typeof createPlexSharingClient>;

// Wraps a thrown fetch (DNS, refused, TLS) as a 502-status PlexSharingError.
function networkError(err: unknown): PlexSharingError {
  const message =
    err instanceof Error ? err.message : "Plex sharing request failed";
  return new PlexSharingError(message);
}

/**
 * Guards the invite payload before it can leave the process.
 *
 * @throws PlexSharingError with status 400. An empty array is rejected because
 * plex.tv reads empty `library_section_ids` as "share everything", so a
 * dropped selection would quietly hand over the whole server.
 */
function validateSectionIds(sectionIds: number[]): void {
  if (!Array.isArray(sectionIds) || sectionIds.length === 0) {
    throw new PlexSharingError(
      "sectionIds must be a non-empty array of integers (empty means all libraries to Plex)",
      400,
    );
  }
  for (const id of sectionIds) {
    if (!Number.isInteger(id)) {
      throw new PlexSharingError(
        "sectionIds must be a non-empty array of integers (empty means all libraries to Plex)",
        400,
      );
    }
  }
}

// Match each <Section ...> opening tag; skip tags missing required attrs.
function parseShareableSections(xml: string): ShareableSection[] {
  const sections: ShareableSection[] = [];
  const tags = xml.match(/<Section\b[^>]*>/g) ?? [];

  for (const tag of tags) {
    // Both numbers are parsed, and both are kept. See ShareableSection: id is
    // the sharing id that goes to plex.tv, key is the local section number.
    const id = attr(tag, "id");
    const key = attr(tag, "key");
    const title = attr(tag, "title");
    const type = attr(tag, "type");
    if (
      id === undefined ||
      key === undefined ||
      title === undefined ||
      type === undefined
    ) {
      continue;
    }
    if (!/^\d+$/.test(id) || !/^\d+$/.test(key)) {
      continue;
    }
    sections.push({
      id: Number(id),
      key: Number(key),
      title,
      type,
    });
  }

  return sections;
}

// Match each <Invite ...> opening tag. Rows that can't be trusted are skipped,
// not defaulted, so a malformed one never becomes a fake pending invite.
function parsePendingInvites(xml: string): PendingInvite[] {
  const invites: PendingInvite[] = [];
  const tags = xml.match(/<Invite\b[^>]*>/g) ?? [];

  for (const tag of tags) {
    const id = attr(tag, "id");
    const email = attr(tag, "email");
    const username = attr(tag, "username");
    const createdAt = attr(tag, "createdAt");
    // username may be "" (no-Plex-account invitee) — still required as an
    // attribute, but empty is valid. email and id are required; createdAt
    // must be a numeric epoch.
    if (
      id === undefined ||
      id === "" ||
      email === undefined ||
      email === "" ||
      username === undefined ||
      createdAt === undefined
    ) {
      continue;
    }
    if (!/^\d+$/.test(createdAt)) {
      continue;
    }
    invites.push({
      id,
      email,
      username,
      createdAt: Number(createdAt),
    });
  }

  return invites;
}

// Match each <SharedServer ...> opening tag. Same regex sharedServerAccess.ts
// runs over the same endpoint, reading different attributes off it: that file
// wants accessToken, this one wants who and when.
function parseShares(xml: string): SharedServerShare[] {
  const shares: SharedServerShare[] = [];
  const tags = xml.match(/<SharedServer\b[^>]*>/g) ?? [];

  for (const tag of tags) {
    const userId = attr(tag, "userID");
    const username = attr(tag, "username");
    const email = attr(tag, "email");
    if (userId === undefined || username === undefined || email === undefined) {
      continue;
    }
    if (!/^\d+$/.test(userId)) {
      continue;
    }

    const invitedAtRaw = attr(tag, "invitedAt");
    const acceptedAtRaw = attr(tag, "acceptedAt");
    const allLibrariesRaw = attr(tag, "allLibraries");

    shares.push({
      userId: Number(userId),
      username,
      email,
      invitedAt: parseEpochOrNull(invitedAtRaw),
      // UNVERIFIED: accepted shares were observed with a real acceptedAt epoch.
      // Behavior for an unaccepted invite row (attribute missing vs "0" vs row
      // absent) was never seen live — treat missing or "0" as null.
      acceptedAt: parseAcceptedAt(acceptedAtRaw),
      allLibraries: allLibrariesRaw === "1",
    });
  }

  return shares;
}

// Epoch-seconds attribute to a number, with every "no value" spelling folded
// into null: absent, empty, non-numeric, or a literal "0".
function parseEpochOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === "" || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return n === 0 ? null : n;
}

function parseAcceptedAt(raw: string | undefined): number | null {
  // See UNVERIFIED note in parseShares — missing or "0" → null.
  return parseEpochOrNull(raw);
}

/** Exported for unit tests of attribute-name boundary matching. */
export function attr(tag: string, name: string): string | undefined {
  // Require a real attribute boundary (whitespace or the opening `<`) so
  // attr(tag, "name") does not match username=, and attr(tag, "id") does not
  // match the trailing "id" inside guid=.
  return tag.match(new RegExp(`(?:\\s|<)${name}="([^"]*)"`))?.[1];
}
