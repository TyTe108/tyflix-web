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

export class PlexSharingError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "PlexSharingError";
    this.status = status;
  }
}

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

export type PendingInvite = {
  id: number;
  email: string;
  username: string;
  createdAt: number;
};

export type SharedServerShare = {
  userId: number;
  username: string;
  email: string;
  invitedAt: number | null;
  acceptedAt: number | null;
  allLibraries: boolean;
};

export type InviteResult =
  | { ok: true }
  | { ok: false; reason: "alreadyShared" };

export function createPlexSharingClient(options: PlexSharingClientOptions) {
  const { baseUrl, ownerToken, clientId } = options;
  let cachedMachineId: string | null = null;

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

  async function listShareableSections(): Promise<ShareableSection[]> {
    const machineId = await resolveMachineId();
    const url = `https://plex.tv/api/servers/${machineId}`;
    const xml = await getText(url, plexTvHeaders());
    return parseShareableSections(xml);
  }

  async function inviteToServer(input: {
    email: string;
    sectionIds: number[];
  }): Promise<InviteResult> {
    validateSectionIds(input.sectionIds);

    const machineId = await resolveMachineId();
    const url = `https://plex.tv/api/servers/${machineId}/shared_servers`;
    const body = {
      server_id: machineId,
      shared_server: {
        library_section_ids: input.sectionIds,
        invited_email: input.email,
      },
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

  async function listPendingInvites(): Promise<PendingInvite[]> {
    const url = "https://plex.tv/api/invites/requested";
    const xml = await getText(url, plexTvHeaders());
    return parsePendingInvites(xml);
  }

  async function listShares(): Promise<SharedServerShare[]> {
    const machineId = await resolveMachineId();
    const url = `https://plex.tv/api/servers/${machineId}/shared_servers`;
    const xml = await getText(url, plexTvHeaders());
    return parseShares(xml);
  }

  function plexTvHeaders(): Record<string, string> {
    return {
      "X-Plex-Token": ownerToken,
      "X-Plex-Client-Identifier": clientId,
    };
  }

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

export type PlexSharingClient = ReturnType<typeof createPlexSharingClient>;

function networkError(err: unknown): PlexSharingError {
  const message =
    err instanceof Error ? err.message : "Plex sharing request failed";
  return new PlexSharingError(message);
}

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

function parsePendingInvites(xml: string): PendingInvite[] {
  const invites: PendingInvite[] = [];
  const tags = xml.match(/<Invite\b[^>]*>/g) ?? [];

  for (const tag of tags) {
    const id = attr(tag, "id");
    const email = attr(tag, "email");
    const username = attr(tag, "username");
    const createdAt = attr(tag, "createdAt");
    if (
      id === undefined ||
      email === undefined ||
      username === undefined ||
      createdAt === undefined
    ) {
      continue;
    }
    if (!/^\d+$/.test(id) || !/^\d+$/.test(createdAt)) {
      continue;
    }
    invites.push({
      id: Number(id),
      email,
      username,
      createdAt: Number(createdAt),
    });
  }

  return invites;
}

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
