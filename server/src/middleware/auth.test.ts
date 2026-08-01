// Characterization tests for requireAuth and requireAdmin — the two
// authorization gates in middleware/auth.ts.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import type { SeerrUser } from "../seerr/client";
import { SESSION_COOKIE_NAME } from "../session";
import { requireAdmin, requireAuth } from "./auth";
import { clearPermissionCacheForTests } from "./revalidatePermissions";

const SECRET = "sixteen-chars!!!";

const sessionData = {
  seerrUserId: 7,
  plexId: 42,
  plexUsername: "tyler",
  displayName: "Tyler",
  avatar: "https://example.com/a.png" as string | null,
  permissions: 2,
};

// Mirrors session.ts's unexported signSession: HMAC-SHA256 over the JSON
// string (not the base64url), both halves base64url, joined with ".".
function signToken(payload: Record<string, unknown>, secret: string): string {
  const json = JSON.stringify(payload);
  const payloadPart = Buffer.from(json, "utf8").toString("base64url");
  const sigPart = createHmac("sha256", secret)
    .update(json)
    .digest("base64url");
  return `${payloadPart}.${sigPart}`;
}

function fakeReq(cookieHeader?: string): Request {
  return {
    headers: cookieHeader === undefined ? {} : { cookie: cookieHeader },
  } as Request;
}

// Records status/json and exposes locals so we can assert both the 401/403
// path and the successful publish of res.locals.session.
function fakeRes() {
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const locals: Record<string, unknown> = {};
  const res = {
    locals,
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      jsonBody = body;
      return this;
    },
  };
  return {
    res: res as unknown as Response,
    get statusCode() {
      return statusCode;
    },
    get jsonBody() {
      return jsonBody;
    },
  };
}

function fakeNext(): { next: NextFunction; get calls(): number } {
  let calls = 0;
  const next: NextFunction = () => {
    calls += 1;
  };
  return {
    next,
    get calls() {
      return calls;
    },
  };
}

function validPayload(
  overrides: Partial<typeof sessionData> & { iat?: number; exp?: number } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ...sessionData,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

function seerrUser(overrides: Partial<SeerrUser> = {}): SeerrUser {
  return {
    id: 7,
    plexId: 42,
    plexUsername: "tyler",
    displayName: "Tyler",
    email: null,
    permissions: 2,
    ...overrides,
  };
}

function stubSeerr(
  handler: (id: number) => Promise<SeerrUser | null>,
): { getUserById: (id: number) => Promise<SeerrUser | null>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async getUserById(id: number) {
      calls.push(id);
      return handler(id);
    },
  };
}

// Echoes the cookie's permissions so the Phase 31 characterization cases keep
// asserting the same status codes after Seerr revalidation was added.
function echoSeerr(permissions: number) {
  return stubSeerr(async (id) => seerrUser({ id, permissions }));
}

async function run(
  mw: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await Promise.resolve(mw(req, res, next));
}

beforeEach(() => {
  clearPermissionCacheForTests();
});

describe("requireAuth", () => {
  it("returns 401 and never calls next when there is no Cookie header", async () => {
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(2);

    await run(requireAuth(SECRET, seerr), fakeReq(), fake.res, tracker.next);

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
    assert.equal(fake.res.locals.session, undefined);
    assert.deepEqual(seerr.calls, []);
  });

  it("returns 401 when a valid JSON payload is paired with the wrong signature", async () => {
    const payload = validPayload();
    const token = signToken(payload, SECRET);
    const [payloadPart, sigPart] = token.split(".");
    const alteredPayload = Buffer.from(
      JSON.stringify({ ...payload, plexId: 999 }),
      "utf8",
    ).toString("base64url");
    assert.notEqual(alteredPayload, payloadPart);
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(2);

    await run(
      requireAuth(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${alteredPayload}.${sigPart}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
    assert.deepEqual(seerr.calls, []);
  });

  it("returns 401 when the cookie was signed with a different secret", async () => {
    const token = signToken(validPayload(), "different-secret!");
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(2);

    await run(
      requireAuth(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
  });

  it("returns 401 for a cookie whose payload half is not valid base64url JSON", async () => {
    const payload = validPayload();
    const token = signToken(payload, SECRET);
    const [payloadPart, sigPart] = token.split(".");
    // Flipping the first char corrupts the payload into bytes that aren't
    // valid JSON, so readSession bails at JSON.parse rather than at the
    // signature comparison. That's a different branch from the two tests
    // above, which is the whole reason this case is kept separate.
    const badPayload = `${payloadPart[0] === "A" ? "B" : "A"}${payloadPart.slice(1)}`;
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(2);

    await run(
      requireAuth(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${badPayload}.${sigPart}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
  });

  it("returns 401 for a correctly signed but expired cookie", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      validPayload({ iat: now - 100, exp: now - 1 }),
      SECRET,
    );
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(2);

    await run(
      requireAuth(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
  });

  it("publishes the session and calls next for a valid unexpired cookie", async () => {
    const payload = validPayload();
    const token = signToken(payload, SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(payload.permissions);

    await run(
      requireAuth(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(tracker.calls, 1);
    assert.equal(fake.statusCode, undefined);
    assert.deepEqual(fake.res.locals.session, payload);
  });
});

describe("requireAdmin", () => {
  it("returns 401 with not-authenticated body when there is no cookie", async () => {
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(2);

    await run(requireAdmin(SECRET, seerr), fakeReq(), fake.res, tracker.next);

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
  });

  it("returns 403 for a valid session with permissions 0", async () => {
    const token = signToken(validPayload({ permissions: 0 }), SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(0);

    await run(
      requireAdmin(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 403);
    assert.deepEqual(fake.jsonBody, { error: "forbidden" });
    assert.equal(tracker.calls, 0);
  });

  it("returns 403 for a valid session with permissions 1", async () => {
    const token = signToken(validPayload({ permissions: 1 }), SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(1);

    await run(
      requireAdmin(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 403);
    assert.deepEqual(fake.jsonBody, { error: "forbidden" });
    assert.equal(tracker.calls, 0);
  });

  it("calls next for a valid session with permissions 2", async () => {
    const payload = validPayload({ permissions: 2 });
    const token = signToken(payload, SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(2);

    await run(
      requireAdmin(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(tracker.calls, 1);
    assert.equal(fake.statusCode, undefined);
    assert.deepEqual(fake.res.locals.session, payload);
  });

  it("calls next for a valid session with permissions 6", async () => {
    const payload = validPayload({ permissions: 6 });
    const token = signToken(payload, SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();
    const seerr = echoSeerr(6);

    await run(
      requireAdmin(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(tracker.calls, 1);
    assert.equal(fake.statusCode, undefined);
    assert.deepEqual(fake.res.locals.session, payload);
  });
});

describe("Seerr permission revalidation", () => {
  it("requireAdmin returns 403 when Seerr says non-admin despite an admin cookie", async () => {
    // Cookie carries admin (2); Seerr alone returns 0. The only way to get 403
    // here is the live-permissions branch — a missing cookie would be 401, and
    // an unreachable Seerr would be 503.
    const seerr = stubSeerr(async () => seerrUser({ permissions: 0 }));
    const token = signToken(validPayload({ permissions: 2 }), SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    await run(
      requireAdmin(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 403);
    assert.deepEqual(fake.jsonBody, { error: "forbidden" });
    assert.equal(tracker.calls, 0);
    assert.deepEqual(seerr.calls, [7]);
  });

  it("requireAdmin allows a user newly granted admin in Seerr without re-login", async () => {
    // Cookie still says 0; Seerr alone returns admin. 403 would mean we trusted
    // the cookie; 503 would mean the stub threw.
    const seerr = stubSeerr(async () => seerrUser({ permissions: 2 }));
    const token = signToken(validPayload({ permissions: 0 }), SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    await run(
      requireAdmin(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(tracker.calls, 1);
    assert.equal(fake.statusCode, undefined);
    assert.equal(
      (fake.res.locals.session as { permissions: number }).permissions,
      2,
    );
  });

  it("requireAuth returns 503 when the Seerr client throws", async () => {
    // Stub fails in exactly one mode: throw. A 401 here would mean we treated
    // the throw as "account gone"; a fall-through to cookie perms would call next.
    const seerr = stubSeerr(async () => {
      throw new Error("connection refused");
    });
    const token = signToken(validPayload({ permissions: 2 }), SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    await run(
      requireAuth(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 503);
    assert.equal(tracker.calls, 0);
    assert.deepEqual(seerr.calls, [7]);
  });

  it("requireAdmin returns 503 when the Seerr client throws", async () => {
    const seerr = stubSeerr(async () => {
      throw new Error("connection refused");
    });
    const token = signToken(validPayload({ permissions: 2 }), SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    await run(
      requireAdmin(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 503);
    assert.equal(tracker.calls, 0);
    assert.deepEqual(seerr.calls, [7]);
  });

  it("requireAuth returns 401 when Seerr reports the account no longer exists", async () => {
    // Stub fails in exactly one mode: null user (the 404 signal). A 503 here
    // would mean we collapsed not-found into unreachable.
    const seerr = stubSeerr(async () => null);
    const token = signToken(validPayload({ permissions: 2 }), SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    await run(
      requireAuth(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
    assert.deepEqual(seerr.calls, [7]);
  });

  it("happy path: publishes Seerr permissions on res.locals.session", async () => {
    const seerr = stubSeerr(async () => seerrUser({ permissions: 6 }));
    const payload = validPayload({ permissions: 2 });
    const token = signToken(payload, SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    await run(
      requireAuth(SECRET, seerr),
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(tracker.calls, 1);
    assert.equal(fake.statusCode, undefined);
    assert.deepEqual(fake.res.locals.session, {
      ...payload,
      permissions: 6,
    });
    assert.deepEqual(seerr.calls, [7]);
  });
});

describe("permission revalidation cache", () => {
  it("collapses N requests for one user into one Seerr call within the window", async () => {
    const seerr = stubSeerr(async () => seerrUser({ permissions: 2 }));
    const token = signToken(validPayload({ permissions: 2 }), SECRET);
    let nowMs = 1_000;
    const mw = requireAuth(SECRET, seerr, { now: () => nowMs });

    for (let i = 0; i < 5; i++) {
      const fake = fakeRes();
      const tracker = fakeNext();
      await run(
        mw,
        fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
        fake.res,
        tracker.next,
      );
      assert.equal(tracker.calls, 1, `request ${i} should succeed`);
    }

    assert.equal(seerr.calls.length, 1);
  });

  it("keeps separate cache entries per user (no cross-user leakage)", async () => {
    const seerr = stubSeerr(async (id) =>
      seerrUser({ id, permissions: id === 7 ? 2 : 0 }),
    );
    let nowMs = 1_000;
    const mw = requireAuth(SECRET, seerr, { now: () => nowMs });

    const tokenA = signToken(
      validPayload({ seerrUserId: 7, permissions: 2 }),
      SECRET,
    );
    const tokenB = signToken(
      validPayload({ seerrUserId: 8, permissions: 0 }),
      SECRET,
    );

    const fakeA = fakeRes();
    const fakeB = fakeRes();
    await run(
      mw,
      fakeReq(`${SESSION_COOKIE_NAME}=${tokenA}`),
      fakeA.res,
      fakeNext().next,
    );
    await run(
      mw,
      fakeReq(`${SESSION_COOKIE_NAME}=${tokenB}`),
      fakeB.res,
      fakeNext().next,
    );

    assert.deepEqual(seerr.calls, [7, 8]);
    assert.equal(
      (fakeA.res.locals.session as { permissions: number }).permissions,
      2,
    );
    assert.equal(
      (fakeB.res.locals.session as { permissions: number }).permissions,
      0,
    );
  });

  it("issues a fresh Seerr call after the cache window elapses", async () => {
    const seerr = stubSeerr(async () => seerrUser({ permissions: 2 }));
    const token = signToken(validPayload({ permissions: 2 }), SECRET);
    let nowMs = 1_000;
    const mw = requireAuth(SECRET, seerr, { now: () => nowMs });

    const first = fakeRes();
    await run(
      mw,
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      first.res,
      fakeNext().next,
    );
    assert.equal(seerr.calls.length, 1);

    nowMs = 1_000 + 10_000 + 1;

    const second = fakeRes();
    await run(
      mw,
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      second.res,
      fakeNext().next,
    );
    assert.equal(seerr.calls.length, 2);
  });

  it("never caches errors — the next request retries after a throw", async () => {
    let shouldFail = true;
    const seerr = stubSeerr(async () => {
      if (shouldFail) {
        throw new Error("timeout");
      }
      return seerrUser({ permissions: 2 });
    });
    const token = signToken(validPayload({ permissions: 2 }), SECRET);
    let nowMs = 1_000;
    const mw = requireAuth(SECRET, seerr, { now: () => nowMs });

    const failed = fakeRes();
    const failedNext = fakeNext();
    await run(
      mw,
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      failed.res,
      failedNext.next,
    );
    assert.equal(failed.statusCode, 503);
    assert.equal(failedNext.calls, 0);

    shouldFail = false;
    const ok = fakeRes();
    const okNext = fakeNext();
    await run(
      mw,
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      ok.res,
      okNext.next,
    );
    assert.equal(okNext.calls, 1);
    assert.equal(ok.statusCode, undefined);
    assert.equal(seerr.calls.length, 2);
  });
});
