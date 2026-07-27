import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import type {
  AccessRequest,
  MarkDeniedInput,
  MarkInvitedInput,
} from "../accessRequests/store";
import { AccessRequestTransitionError } from "../accessRequests/store";
import {
  PlexSharingError,
  type InviteResult,
  type ShareableSection,
} from "../plex/sharing";
import { issueSession, SESSION_COOKIE_NAME } from "../session";
import {
  createAdminAccessRequestsRouter,
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

type FakeStore = AdminAccessRequestsRouterDeps["store"] & {
  records: AccessRequest[];
  markInvitedCalls: Array<{ id: string; input: MarkInvitedInput }>;
  markDeniedCalls: Array<{ id: string; input: MarkDeniedInput | undefined }>;
  failNextMarkInvited?: Error;
};

function createFakeStore(initial: AccessRequest[] = []): FakeStore {
  const store: FakeStore = {
    records: initial.map((r) => ({ ...r })),
    markInvitedCalls: [],
    markDeniedCalls: [],
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
  };
  return store;
}

type FakeSharing = AdminAccessRequestsRouterDeps["sharing"] & {
  inviteCalls: Array<{ email: string; sectionIds: number[] }>;
  sections: ShareableSection[];
  inviteResult: InviteResult | (() => InviteResult);
  inviteError?: Error;
  sectionsError?: Error;
};

function createFakeSharing(
  overrides: Partial<FakeSharing> = {},
): FakeSharing {
  const sharing: FakeSharing = {
    inviteCalls: [],
    sections: SECTIONS.slice(),
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

  it("GET / returns stored rows", async () => {
    const rows = [
      pendingRecord({ id: "a" }),
      pendingRecord({ id: "b", email: "other@example.com" }),
    ];
    const app = buildApp(createFakeStore(rows), createFakeSharing());
    const response = await request(app, "/api/admin/access-requests", {
      cookie: sessionCookie(ADMIN_PERMISSION),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), rows);
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
