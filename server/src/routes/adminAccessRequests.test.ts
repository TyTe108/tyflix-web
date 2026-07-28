import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import type {
  AccessRequest,
  MarkAcceptedInput,
  MarkDeniedInput,
  MarkInvitedInput,
} from "../accessRequests/store";
import { AccessRequestTransitionError } from "../accessRequests/store";
import {
  PlexSharingError,
  type InviteResult,
  type PendingInvite,
  type ShareableSection,
  type SharedServerShare,
} from "../plex/sharing";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import {
  createAdminAccessRequestsRouter,
  type AccessRequestsListResponse,
  type AdminAccessRequestsRouterDeps,
} from "./adminAccessRequests";

const SECRET = "sixteen-chars!!!";
const ADMIN_PERMISSION = 2;

const SECTIONS: ShareableSection[] = [
  { id: 122223622, key: 1, title: "Movies", type: "movie" },
  { id: 122223654, key: 2, title: "TV Shows", type: "show" },
];

type FakeRes = {
  cookies: Array<{ name: string; value: string }>;
  cookie(name: string, value: string): void;
};

function sessionCookie(permissions = 0): string {
  const cookies: Array<{ name: string; value: string }> = [];
  const res: FakeRes = {
    cookies,
    cookie(name, value) {
      cookies.push({ name, value });
    },
  };
  issueSession(
    res as unknown as import("express").Response,
    {
      seerrUserId: 1,
      plexId: 10,
      plexUsername: "tyler",
      displayName: "Tyler",
      avatar: null,
      permissions,
    },
    { secret: SECRET, secure: false },
  );
  return `${SESSION_COOKIE_NAME}=${cookies[0].value}`;
}

function pendingRecord(
  overrides: Partial<AccessRequest> = {},
): AccessRequest {
  return {
    id: "req-1",
    email: "someone@example.com",
    plexUsername: null,
    name: "Some One",
    note: "friend",
    hasPlexAccount: false,
    status: "pending",
    createdAt: 1_785_000_000,
    decidedAt: null,
    invitedAt: null,
    acceptedAt: null,
    sectionIds: null,
    adminNote: null,
    sourceIp: "203.0.113.9",
    ...overrides,
  };
}

function invitedRecord(
  overrides: Partial<AccessRequest> = {},
): AccessRequest {
  return pendingRecord({
    status: "invited",
    decidedAt: 1_785_000_050,
    invitedAt: 1_785_000_050,
    sectionIds: [122223622],
    ...overrides,
  });
}

type FakeStore = AdminAccessRequestsRouterDeps["store"] & {
  records: AccessRequest[];
  markInvitedCalls: Array<{ id: string; input: MarkInvitedInput }>;
  markDeniedCalls: Array<{ id: string; input: MarkDeniedInput | undefined }>;
  markAcceptedCalls: Array<{ id: string; input: MarkAcceptedInput }>;
  failNextMarkInvited?: Error;
  failNextMarkAccepted?: Error;
};

function createFakeStore(initial: AccessRequest[] = []): FakeStore {
  const store: FakeStore = {
    records: initial.map((r) => ({ ...r })),
    markInvitedCalls: [],
    markDeniedCalls: [],
    markAcceptedCalls: [],
    list() {
      return this.records.slice();
    },
    findById(id: string) {
      return this.records.find((r) => r.id === id);
    },
    async markInvited(id: string, input: MarkInvitedInput) {
      this.markInvitedCalls.push({ id, input });
      if (this.failNextMarkInvited) {
        const err = this.failNextMarkInvited;
        this.failNextMarkInvited = undefined;
        throw err;
      }
      const index = this.records.findIndex((r) => r.id === id);
      if (index < 0) {
        throw new Error(`access request not found: ${id}`);
      }
      const current = this.records[index]!;
      if (current.status !== "pending") {
        throw new AccessRequestTransitionError(id, current.status, "invited");
      }
      const updated: AccessRequest = {
        ...current,
        status: "invited",
        decidedAt: Math.floor(Date.now() / 1000),
        invitedAt: input.invitedAt,
        sectionIds: input.sectionIds.slice(),
        adminNote:
          input.adminNote !== undefined ? input.adminNote : current.adminNote,
      };
      this.records[index] = updated;
      return updated;
    },
    async markDenied(id: string, input?: MarkDeniedInput) {
      this.markDeniedCalls.push({ id, input });
      const index = this.records.findIndex((r) => r.id === id);
      if (index < 0) {
        throw new Error(`access request not found: ${id}`);
      }
      const current = this.records[index]!;
      if (current.status !== "pending") {
        throw new AccessRequestTransitionError(id, current.status, "denied");
      }
      const updated: AccessRequest = {
        ...current,
        status: "denied",
        decidedAt: Math.floor(Date.now() / 1000),
        adminNote:
          input?.adminNote !== undefined
            ? input.adminNote
            : current.adminNote,
      };
      this.records[index] = updated;
      return updated;
    },
    async markAccepted(id: string, input: MarkAcceptedInput) {
      this.markAcceptedCalls.push({ id, input });
      if (this.failNextMarkAccepted) {
        const err = this.failNextMarkAccepted;
        this.failNextMarkAccepted = undefined;
        throw err;
      }
      const index = this.records.findIndex((r) => r.id === id);
      if (index < 0) {
        throw new Error(`access request not found: ${id}`);
      }
      const current = this.records[index]!;
      if (current.status !== "invited") {
        throw new AccessRequestTransitionError(id, current.status, "accepted");
      }
      const updated: AccessRequest = {
        ...current,
        status: "accepted",
        acceptedAt: input.acceptedAt,
      };
      this.records[index] = updated;
      return updated;
    },
  };
  return store;
}

type FakeSharing = AdminAccessRequestsRouterDeps["sharing"] & {
  inviteCalls: Array<{ email: string; sectionIds: number[] }>;
  pendingCalls: number;
  sharesCalls: number;
  sections: ShareableSection[];
  pendingInvites: PendingInvite[];
  shares: SharedServerShare[];
  inviteResult: InviteResult | (() => InviteResult);
  inviteError?: Error;
  sectionsError?: Error;
  pendingError?: Error;
  sharesError?: Error;
};

function createFakeSharing(
  overrides: Partial<FakeSharing> = {},
): FakeSharing {
  const sharing: FakeSharing = {
    inviteCalls: [],
    pendingCalls: 0,
    sharesCalls: 0,
    sections: SECTIONS.slice(),
    pendingInvites: [],
    shares: [],
    inviteResult: { ok: true },
    async listShareableSections() {
      if (this.sectionsError) {
        throw this.sectionsError;
      }
      return this.sections.slice();
    },
    async inviteToServer(input: { email: string; sectionIds: number[] }) {
      this.inviteCalls.push({
        email: input.email,
        sectionIds: input.sectionIds.slice(),
      });
      if (this.inviteError) {
        throw this.inviteError;
      }
      return typeof this.inviteResult === "function"
        ? this.inviteResult()
        : this.inviteResult;
    },
    async listPendingInvites() {
      this.pendingCalls += 1;
      if (this.pendingError) {
        throw this.pendingError;
      }
      return this.pendingInvites.slice();
    },
    async listShares() {
      this.sharesCalls += 1;
      if (this.sharesError) {
        throw this.sharesError;
      }
      return this.shares.slice();
    },
    ...overrides,
  };
  return sharing;
}

function buildApp(
  store: AdminAccessRequestsRouterDeps["store"],
  sharing: AdminAccessRequestsRouterDeps["sharing"],
): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/admin/access-requests",
    createAdminAccessRequestsRouter({
      store,
      sharing,
      sessionSecret: SECRET,
    }),
  );
  return app;
}

async function request(
  app: express.Express,
  path: string,
  options: {
    method?: string;
    cookie?: string | null;
    body?: unknown;
  } = {},
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const headers: Record<string, string> = {};
    if (options.cookie) {
      headers.Cookie = options.cookie;
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return await fetch(
      `http://127.0.0.1:${address.port}${path}`,
      {
        method: options.method ?? "GET",
        headers,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe("admin access-requests routes", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = buildApp(createFakeStore(), createFakeSharing());
    const response = await request(app, "/api/admin/access-requests", {
      cookie: null,
    });
    assert.equal(response.status, 401);
  });

  it("returns 403 when authenticated but not admin", async () => {
    const app = buildApp(createFakeStore(), createFakeSharing());
    const response = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(0),
    });
    assert.equal(response.status, 403);
  });

  it("GET / returns { requests, reconciledAt } and skips Plex with no invited rows", async () => {
    const rows = [
      pendingRecord({ id: "a" }),
      pendingRecord({
        id: "b",
        email: "other@example.com",
        status: "denied",
        decidedAt: 1,
      }),
    ];
    const sharing = createFakeSharing();
    const app = buildApp(createFakeStore(rows), sharing);
    const response = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as AccessRequestsListResponse;
    assert.deepEqual(body.requests, rows);
    assert.equal(typeof body.reconciledAt, "number");
    assert.equal(sharing.pendingCalls, 0);
    assert.equal(sharing.sharesCalls, 0);
  });

  it("GET /sections returns shareable sections", async () => {
    const app = buildApp(createFakeStore(), createFakeSharing());
    const response = await request(
      app,
      "/api/admin/access-requests/sections",
      { cookie: sessionCookie(ADMIN_PERMISSION) },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), SECTIONS);
  });

  it("GET /count returns pending count without calling Plex", async () => {
    const store = createFakeStore([
      pendingRecord({ id: "p1" }),
      pendingRecord({ id: "p2", email: "two@example.com" }),
      invitedRecord({ id: "i1", email: "invited@example.com" }),
      pendingRecord({
        id: "d1",
        email: "denied@example.com",
        status: "denied",
        decidedAt: 1,
      }),
    ]);
    const sharing = createFakeSharing();
    const app = buildApp(store, sharing);

    const response = await request(app, "/api/admin/access-requests/count", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { pending: 2 });
    assert.equal(sharing.pendingCalls, 0);
    assert.equal(sharing.sharesCalls, 0);
    assert.equal(sharing.inviteCalls.length, 0);
  });

  it("GET /count returns 401/403 like other admin routes", async () => {
    const app = buildApp(createFakeStore(), createFakeSharing());
    assert.equal(
      (
        await request(app, "/api/admin/access-requests/count", {
          cookie: null,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request(app, "/api/admin/access-requests/count", {
          cookie: sessionCookie(0),
        })
      ).status,
      403,
    );
  });

  it("approve with no sectionIds invites all shareable ids and marks invited", async () => {
    const store = createFakeStore([pendingRecord()]);
    const sharing = createFakeSharing();
    const app = buildApp(store, sharing);

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/approve",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: {},
      },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as AccessRequest;
    assert.equal(body.status, "invited");
    assert.deepEqual(body.sectionIds, [122223622, 122223654]);
    assert.ok(body.invitedAt !== null);
    assert.ok(body.decidedAt !== null);
    assert.deepEqual(sharing.inviteCalls, [
      {
        email: "someone@example.com",
        sectionIds: [122223622, 122223654],
      },
    ]);
    assert.equal(store.records[0]?.status, "invited");
  });

  it("approve with a section id not in the live list returns 400 and skips invite", async () => {
    const store = createFakeStore([pendingRecord()]);
    const sharing = createFakeSharing();
    const app = buildApp(store, sharing);

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/approve",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: { sectionIds: [1] },
      },
    );

    assert.equal(response.status, 400);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /section id/i,
    );
    assert.equal(sharing.inviteCalls.length, 0);
    assert.equal(store.records[0]?.status, "pending");
  });

  it("approve on invited or denied returns 409 and skips invite", async () => {
    for (const status of ["invited", "denied"] as const) {
      const store = createFakeStore([pendingRecord({ status })]);
      const sharing = createFakeSharing();
      const app = buildApp(store, sharing);

      const response = await request(
        app,
        "/api/admin/access-requests/req-1/approve",
        {
          method: "POST",
          cookie: sessionCookie(ADMIN_PERMISSION),
          body: {},
        },
      );

      assert.equal(response.status, 409);
      assert.equal(sharing.inviteCalls.length, 0);
      assert.equal(store.markInvitedCalls.length, 0);
    }
  });

  it("approve treats alreadyShared as success and records adminNote", async () => {
    const store = createFakeStore([pendingRecord()]);
    const sharing = createFakeSharing({
      inviteResult: { ok: false, reason: "alreadyShared" },
    });
    const app = buildApp(store, sharing);

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/approve",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: { sectionIds: [122223622] },
      },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as AccessRequest;
    assert.equal(body.status, "invited");
    assert.match(body.adminNote ?? "", /Already shared/i);
    assert.equal(sharing.inviteCalls.length, 1);
  });

  it("leaves the row pending when inviteToServer throws", async () => {
    const store = createFakeStore([pendingRecord()]);
    const sharing = createFakeSharing({
      inviteError: new PlexSharingError("Plex request failed (500)", 500),
    });
    const app = buildApp(store, sharing);

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/approve",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: {},
      },
    );

    assert.equal(response.status, 500);
    assert.equal(store.records[0]?.status, "pending");
    assert.equal(store.markInvitedCalls.length, 0);
  });

  it("deny flips pending to denied without calling Plex", async () => {
    const store = createFakeStore([pendingRecord()]);
    const sharing = createFakeSharing();
    const app = buildApp(store, sharing);

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/deny",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: { adminNote: "not today" },
      },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as AccessRequest;
    assert.equal(body.status, "denied");
    assert.equal(body.adminNote, "not today");
    assert.ok(body.decidedAt !== null);
    assert.equal(sharing.inviteCalls.length, 0);
  });

  it("deny without adminNote stores null", async () => {
    const store = createFakeStore([pendingRecord()]);
    const app = buildApp(store, createFakeSharing());

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/deny",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: {},
      },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as AccessRequest;
    assert.equal(body.status, "denied");
    assert.equal(body.adminNote, null);
  });

  it("deny rejects a non-string adminNote with 400", async () => {
    const store = createFakeStore([pendingRecord()]);
    const app = buildApp(store, createFakeSharing());

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/deny",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: { adminNote: 12 },
      },
    );

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /adminNote must be a string/i);
    assert.equal(store.records[0]?.status, "pending");
  });

  it("deny rejects an adminNote over 280 characters with 400", async () => {
    const store = createFakeStore([pendingRecord()]);
    const app = buildApp(store, createFakeSharing());
    const adminNote = "x".repeat(281);

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/deny",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: { adminNote },
      },
    );

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /at most 280/i);
    assert.equal(store.records[0]?.status, "pending");
    assert.equal(store.records[0]?.adminNote, null);
  });

  it("approve unknown id returns 404", async () => {
    const app = buildApp(createFakeStore(), createFakeSharing());
    const response = await request(
      app,
      "/api/admin/access-requests/missing/approve",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: {},
      },
    );
    assert.equal(response.status, 404);
  });

  it("surfaces store write failure after a successful invite as 5xx", async () => {
    const store = createFakeStore([pendingRecord()]);
    store.failNextMarkInvited = new Error("disk full");
    const sharing = createFakeSharing();
    const app = buildApp(store, sharing);

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/approve",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: {},
      },
    );

    assert.equal(response.status, 500);
    assert.equal(sharing.inviteCalls.length, 1);
    assert.equal(store.records[0]?.status, "pending");
  });

  it("fails approve when listShareableSections throws (no empty fallback)", async () => {
    const store = createFakeStore([pendingRecord()]);
    const sharing = createFakeSharing({
      sectionsError: new PlexSharingError("sections unavailable", 502),
    });
    const app = buildApp(store, sharing);

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/approve",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: {},
      },
    );

    assert.equal(response.status, 502);
    assert.equal(sharing.inviteCalls.length, 0);
    assert.equal(store.records[0]?.status, "pending");
  });

  it("fails approve when the shareable section list is empty", async () => {
    const store = createFakeStore([pendingRecord()]);
    const sharing = createFakeSharing({ sections: [] });
    const app = buildApp(store, sharing);

    const response = await request(
      app,
      "/api/admin/access-requests/req-1/approve",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: {},
      },
    );

    assert.equal(response.status, 502);
    assert.equal(sharing.inviteCalls.length, 0);
  });
});

describe("access-request reconciliation", () => {
  it("marks invited rows accepted when email is in shared_servers", async () => {
    const store = createFakeStore([
      invitedRecord({
        email: "  Someone@Example.COM ",
      }),
    ]);
    // Store already normalizes on add; simulate stored normalized email.
    store.records[0]!.email = "someone@example.com";

    const sharing = createFakeSharing({
      shares: [
        {
          userId: 1,
          username: "someone",
          email: "  SOMEONE@example.com ",
          invitedAt: 1_785_000_040,
          acceptedAt: 1_785_000_090,
          allLibraries: false,
        },
      ],
    });
    const app = buildApp(store, sharing);

    const response = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as AccessRequestsListResponse;
    assert.equal(body.requests[0]?.status, "accepted");
    assert.equal(body.requests[0]?.acceptedAt, 1_785_000_090);
    assert.equal(body.requests[0]?.plexInviteMissing, undefined);
    assert.equal(typeof body.reconciledAt, "number");
    assert.equal(store.records[0]?.status, "accepted");
    assert.equal(store.markAcceptedCalls.length, 1);

    // Within cache window: still invited? already accepted — no Plex on next
    // read if no invited rows remain.
    const second = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    const secondBody = (await second.json()) as AccessRequestsListResponse;
    assert.equal(secondBody.requests[0]?.status, "accepted");
    assert.equal(sharing.pendingCalls, 1);
    assert.equal(sharing.sharesCalls, 1);
  });

  it("leaves invited rows alone when still in invites/requested", async () => {
    const store = createFakeStore([invitedRecord()]);
    const sharing = createFakeSharing({
      pendingInvites: [
        {
          id: "60318749",
          email: "Someone@Example.COM",
          username: "someone",
          createdAt: 1_785_000_050,
        },
      ],
    });
    const app = buildApp(store, sharing);

    const response = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    const body = (await response.json()) as AccessRequestsListResponse;
    assert.equal(body.requests[0]?.status, "invited");
    assert.equal(body.requests[0]?.plexInviteMissing, undefined);
    assert.equal(store.markAcceptedCalls.length, 0);
    assert.equal(store.records[0]?.status, "invited");
  });

  it("flags invited rows missing from both Plex lists without mutating", async () => {
    const store = createFakeStore([invitedRecord()]);
    const sharing = createFakeSharing();
    const app = buildApp(store, sharing);

    const response = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    const body = (await response.json()) as AccessRequestsListResponse;
    assert.equal(body.requests[0]?.status, "invited");
    assert.equal(body.requests[0]?.plexInviteMissing, true);
    assert.equal(store.records[0]?.status, "invited");
    assert.equal(store.markAcceptedCalls.length, 0);
  });

  it("does not touch pending/denied rows and does not call Plex for them alone", async () => {
    const store = createFakeStore([
      pendingRecord({ id: "p" }),
      pendingRecord({
        id: "d",
        email: "denied@example.com",
        status: "denied",
        decidedAt: 1,
      }),
    ]);
    const sharing = createFakeSharing();
    const app = buildApp(store, sharing);

    const response = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    const body = (await response.json()) as AccessRequestsListResponse;
    assert.equal(body.requests.length, 2);
    assert.equal(sharing.pendingCalls, 0);
    assert.equal(sharing.sharesCalls, 0);
    assert.equal(store.markAcceptedCalls.length, 0);
  });

  it("skips reconciliation entirely when Plex throws", async () => {
    const store = createFakeStore([invitedRecord()]);
    const sharing = createFakeSharing({
      pendingError: new PlexSharingError("plex down", 502),
    });
    const app = buildApp(store, sharing);

    const response = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    const body = (await response.json()) as AccessRequestsListResponse;
    assert.equal(body.reconciledAt, null);
    assert.equal(body.requests[0]?.status, "invited");
    assert.equal(body.requests[0]?.plexInviteMissing, undefined);
    assert.equal(store.records[0]?.status, "invited");
    assert.equal(store.markAcceptedCalls.length, 0);
  });

  it("survives markAccepted write failure without failing the list", async () => {
    const store = createFakeStore([invitedRecord()]);
    store.failNextMarkAccepted = new Error("disk full");
    const sharing = createFakeSharing({
      shares: [
        {
          userId: 1,
          username: "someone",
          email: "someone@example.com",
          invitedAt: 1,
          acceptedAt: 99,
          allLibraries: true,
        },
      ],
    });
    const app = buildApp(store, sharing);

    const response = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as AccessRequestsListResponse;
    assert.equal(body.requests[0]?.status, "invited");
    assert.equal(typeof body.reconciledAt, "number");
    assert.equal(store.records[0]?.status, "invited");
  });

  it("caches Plex lists across reads while invited rows remain", async () => {
    const store = createFakeStore([
      invitedRecord({ id: "a", email: "a@example.com" }),
      invitedRecord({ id: "b", email: "b@example.com" }),
    ]);
    const sharing = createFakeSharing({
      pendingInvites: [
        {
          id: "1",
          email: "a@example.com",
          username: "a",
          createdAt: 1,
        },
        {
          id: "2",
          email: "b@example.com",
          username: "b",
          createdAt: 1,
        },
      ],
    });
    const app = buildApp(store, sharing);

    await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });

    assert.equal(sharing.pendingCalls, 1);
    assert.equal(sharing.sharesCalls, 1);
  });

  it("approve invalidates the Plex cache so the next list re-fetches", async () => {
    const store = createFakeStore([
      invitedRecord({ id: "existing", email: "existing@example.com" }),
      pendingRecord({ id: "req-1", email: "new@example.com" }),
    ]);
    const sharing = createFakeSharing({
      pendingInvites: [
        {
          id: "1",
          email: "existing@example.com",
          username: "existing",
          createdAt: 1,
        },
      ],
    });
    const app = buildApp(store, sharing);

    // Prime the cache with a snapshot that does not yet include the new invite.
    await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    assert.equal(sharing.pendingCalls, 1);
    assert.equal(sharing.sharesCalls, 1);

    const approve = await request(
      app,
      "/api/admin/access-requests/req-1/approve",
      {
        method: "POST",
        cookie: sessionCookie(ADMIN_PERMISSION),
        body: { sectionIds: [122223622] },
      },
    );
    assert.equal(approve.status, 200);

    // Plex now shows the new invite; without invalidation the cached snapshot
    // would flag it plexInviteMissing.
    sharing.pendingInvites = [
      {
        id: "1",
        email: "existing@example.com",
        username: "existing",
        createdAt: 1,
      },
      {
        id: "2",
        email: "new@example.com",
        username: "",
        createdAt: 2,
      },
    ];

    const list = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as AccessRequestsListResponse;
    const approved = body.requests.find((r) => r.id === "req-1");
    assert.equal(approved?.status, "invited");
    assert.equal(approved?.plexInviteMissing, undefined);
    assert.equal(sharing.pendingCalls, 2);
    assert.equal(sharing.sharesCalls, 2);
  });
});
