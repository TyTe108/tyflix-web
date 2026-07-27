import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  PlexSharingError,
  attr,
  createPlexSharingClient,
  type InviteResult,
} from "./sharing";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BASE_URL = "http://10.0.0.10:32400";
const OWNER_TOKEN = "fake-owner-token";
const CLIENT_ID = "fake-client-id";
const MACHINE_ID = "FAKEMACHINEID";

const SERVER_SECTIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer>
  <Server name="Tyflix" machineIdentifier="${MACHINE_ID}">
    <Section id="122223622" key="1" type="movie" title="Movies"/>
    <Section id="122223654" key="2" type="show" title="TV Shows"/>
    <Section id="bad" key="3" type="artist" title="Broken"/>
  </Server>
</MediaContainer>`;

const PENDING_INVITES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="2">
  <Invite id="60318749" createdAt="1784702249" friend="0" home="0" server="1"
          username="schr465" email="has-account@example.com" friendlyName="schr465">
    <Server name="Tyflix" numLibraries="2"/>
  </Invite>
  <Invite id="no-account@example.com" createdAt="1785194557"
          username="" email="no-account@example.com" thumb=""
          friendlyName="no-account@example.com">
    <Server name="Tyflix" numLibraries="2"/>
  </Invite>
  <Invite id="60318750" createdAt="not-an-epoch" username="bad" email="bad@example.com"/>
  <Invite id="60318751" createdAt="1784702250" username="missing-email"/>
</MediaContainer>`;

const SHARES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer size="2">
  <SharedServer id="32649388" username="someone" email="someone@example.com"
                userID="322574854" accessToken="FAKETOKEN" name="Tyflix"
                acceptedAt="1706203113" invitedAt="1706203080" allLibraries="1">
    <Section id="122223622" key="1" title="Movies" type="movie" shared="1"/>
  </SharedServer>
  <SharedServer id="32649389" username="pendinguser" email="pending@example.com"
                userID="322574855" accessToken="FAKETOKEN2" name="Tyflix"
                invitedAt="1706204000" allLibraries="0">
    <Section id="122223622" key="1" title="Movies" type="movie" shared="1"/>
  </SharedServer>
  <SharedServer id="32649390" username="zeroaccept" email="zero@example.com"
                userID="322574856" accessToken="FAKETOKEN3" name="Tyflix"
                acceptedAt="0" invitedAt="1706205000" allLibraries="0"/>
  <SharedServer id="broken" username="broken" name="MissingAttrs"/>
</MediaContainer>`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

function client() {
  return createPlexSharingClient({
    baseUrl: BASE_URL,
    ownerToken: OWNER_TOKEN,
    clientId: CLIENT_ID,
  });
}

type StubHandlers = {
  identity?: () => Response;
  server?: () => Response;
  sharedServersGet?: () => Response;
  sharedServersPost?: (init?: RequestInit) => Response;
  invitesRequested?: () => Response;
};

function stubFetch(handlers: StubHandlers = {}) {
  const calls = {
    identity: 0,
    server: 0,
    sharedServersGet: 0,
    sharedServersPost: 0,
    invitesRequested: 0,
    lastPostBody: null as unknown,
  };

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/identity")) {
      calls.identity += 1;
      return handlers.identity
        ? handlers.identity()
        : jsonResponse(200, {
            MediaContainer: { machineIdentifier: MACHINE_ID },
          });
    }

    if (
      url === `https://plex.tv/api/servers/${MACHINE_ID}/shared_servers` ||
      url.endsWith(`/servers/${MACHINE_ID}/shared_servers`)
    ) {
      if (method === "POST") {
        calls.sharedServersPost += 1;
        if (typeof init?.body === "string") {
          calls.lastPostBody = JSON.parse(init.body);
        }
        return handlers.sharedServersPost
          ? handlers.sharedServersPost(init)
          : textResponse(200, "<ok/>");
      }
      calls.sharedServersGet += 1;
      return handlers.sharedServersGet
        ? handlers.sharedServersGet()
        : textResponse(200, SHARES_XML);
    }

    if (
      url === `https://plex.tv/api/servers/${MACHINE_ID}` ||
      (url.includes(`/api/servers/${MACHINE_ID}`) &&
        !url.includes("shared_servers"))
    ) {
      calls.server += 1;
      return handlers.server
        ? handlers.server()
        : textResponse(200, SERVER_SECTIONS_XML);
    }

    if (url.includes("/api/invites/requested")) {
      calls.invitesRequested += 1;
      return handlers.invitesRequested
        ? handlers.invitesRequested()
        : textResponse(200, PENDING_INVITES_XML);
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  return calls;
}

describe("createPlexSharingClient", () => {
  it("maps shareable section id vs key correctly", async () => {
    stubFetch();
    const sections = await client().listShareableSections();

    assert.deepEqual(sections, [
      { id: 122223622, key: 1, title: "Movies", type: "movie" },
      { id: 122223654, key: 2, title: "TV Shows", type: "show" },
    ]);
  });

  it("caches machine id across calls", async () => {
    const calls = stubFetch();
    const c = client();
    await c.listShareableSections();
    await c.listShareableSections();
    assert.equal(calls.identity, 1);
    assert.equal(calls.server, 2);
  });

  it("inviteToServer succeeds and posts sharing section ids (not keys)", async () => {
    const calls = stubFetch();
    const result = await client().inviteToServer({
      email: "invitee@example.com",
      sectionIds: [122223622, 122223654],
    });

    assert.deepEqual(result, { ok: true } satisfies InviteResult);
    assert.equal(calls.sharedServersPost, 1);
    assert.deepEqual(calls.lastPostBody, {
      server_id: MACHINE_ID,
      shared_server: {
        library_section_ids: [122223622, 122223654],
        invited_email: "invitee@example.com",
      },
      sharing_settings: {
        allowSync: "0",
        allowCameraUpload: "0",
        allowChannels: "0",
        filterMovies: "",
        filterTelevision: "",
        filterMusic: "",
      },
    });
  });

  it("maps HTTP 422 with error code 1999 to alreadyShared", async () => {
    stubFetch({
      sharedServersPost: () =>
        textResponse(422, '<errors><error code="1999"/></errors>'),
    });

    const result = await client().inviteToServer({
      email: "already@example.com",
      sectionIds: [122223622],
    });

    assert.deepEqual(result, {
      ok: false,
      reason: "alreadyShared",
    } satisfies InviteResult);
  });

  it("throws PlexSharingError with status 401 on unauthorized invite", async () => {
    stubFetch({
      sharedServersPost: () => textResponse(401, "unauthorized"),
    });

    await assert.rejects(
      () =>
        client().inviteToServer({
          email: "nope@example.com",
          sectionIds: [122223622],
        }),
      (err: unknown) =>
        err instanceof PlexSharingError && err.status === 401,
    );
  });

  it("wraps a network throw from inviteToServer as PlexSharingError", async () => {
    stubFetch({
      sharedServersPost: () => {
        throw new Error("network down");
      },
    });

    await assert.rejects(
      () =>
        client().inviteToServer({
          email: "nope@example.com",
          sectionIds: [122223622],
        }),
      (err: unknown) =>
        err instanceof PlexSharingError && err.message === "network down",
    );
  });

  it("throws before fetching when sectionIds is empty", async () => {
    const calls = stubFetch();

    await assert.rejects(
      () =>
        client().inviteToServer({
          email: "nope@example.com",
          sectionIds: [],
        }),
      (err: unknown) =>
        err instanceof PlexSharingError &&
        err.status === 400 &&
        err.message.includes("sectionIds"),
    );
    assert.equal(calls.sharedServersPost, 0);
    assert.equal(calls.identity, 0);
  });

  it("throws before fetching when sectionIds contains a non-integer", async () => {
    const calls = stubFetch();

    await assert.rejects(
      () =>
        client().inviteToServer({
          email: "nope@example.com",
          sectionIds: [122223622, 1.5 as unknown as number],
        }),
      (err: unknown) =>
        err instanceof PlexSharingError &&
        err.status === 400 &&
        err.message.includes("sectionIds"),
    );
    assert.equal(calls.sharedServersPost, 0);
  });

  it("attr matches name without taking username", () => {
    const tag =
      '<SharedServer username="someone" email="someone@example.com" name="Tyflix">';
    assert.equal(attr(tag, "name"), "Tyflix");
    assert.equal(attr(tag, "username"), "someone");
  });

  it("attr matches id without taking a suffix inside guid", () => {
    const tag = '<Section guid="plex://abc" id="77" key="1" type="movie" title="Movies"/>';
    assert.equal(attr(tag, "id"), "77");
    assert.equal(attr(tag, "guid"), "plex://abc");
  });

  it("parses acceptedAt when present and null when missing or zero", async () => {
    stubFetch();
    const shares = await client().listShares();

    assert.deepEqual(shares, [
      {
        userId: 322574854,
        username: "someone",
        email: "someone@example.com",
        invitedAt: 1706203080,
        acceptedAt: 1706203113,
        allLibraries: true,
      },
      {
        userId: 322574855,
        username: "pendinguser",
        email: "pending@example.com",
        invitedAt: 1706204000,
        acceptedAt: null,
        allLibraries: false,
      },
      {
        userId: 322574856,
        username: "zeroaccept",
        email: "zero@example.com",
        invitedAt: 1706205000,
        acceptedAt: null,
        allLibraries: false,
      },
    ]);
  });

  it("parses pending invites for both Plex-account and no-account shapes", async () => {
    stubFetch();
    const invites = await client().listPendingInvites();
    assert.deepEqual(invites, [
      {
        id: "60318749",
        email: "has-account@example.com",
        username: "schr465",
        createdAt: 1784702249,
      },
      {
        id: "no-account@example.com",
        email: "no-account@example.com",
        username: "",
        createdAt: 1785194557,
      },
    ]);
  });

  it("throws on non-ok listShares rather than returning empty", async () => {
    stubFetch({
      sharedServersGet: () => textResponse(500, "boom"),
    });

    await assert.rejects(
      () => client().listShares(),
      (err: unknown) => err instanceof PlexSharingError,
    );
  });
});
