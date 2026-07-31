// Characterization tests for requireAuth and requireAdmin — the two
// authorization gates in middleware/auth.ts.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { SESSION_COOKIE_NAME } from "../session";
import { requireAdmin, requireAuth } from "./auth";

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

describe("requireAuth", () => {
  it("returns 401 and never calls next when there is no Cookie header", () => {
    const fake = fakeRes();
    const tracker = fakeNext();

    requireAuth(SECRET)(fakeReq(), fake.res, tracker.next);

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
    assert.equal(fake.res.locals.session, undefined);
  });

  it("returns 401 when a valid JSON payload is paired with the wrong signature", () => {
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

    requireAuth(SECRET)(
      fakeReq(`${SESSION_COOKIE_NAME}=${alteredPayload}.${sigPart}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
  });

  it("returns 401 when the cookie was signed with a different secret", () => {
    const token = signToken(validPayload(), "different-secret!");
    const fake = fakeRes();
    const tracker = fakeNext();

    requireAuth(SECRET)(
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
  });

  it("returns 401 for a cookie whose payload half is not valid base64url JSON", () => {
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

    requireAuth(SECRET)(
      fakeReq(`${SESSION_COOKIE_NAME}=${badPayload}.${sigPart}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
  });

  it("returns 401 for a correctly signed but expired cookie", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      validPayload({ iat: now - 100, exp: now - 1 }),
      SECRET,
    );
    const fake = fakeRes();
    const tracker = fakeNext();

    requireAuth(SECRET)(
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
  });

  it("publishes the session and calls next for a valid unexpired cookie", () => {
    const payload = validPayload();
    const token = signToken(payload, SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    requireAuth(SECRET)(
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
  it("returns 401 with not-authenticated body when there is no cookie", () => {
    const fake = fakeRes();
    const tracker = fakeNext();

    requireAdmin(SECRET)(fakeReq(), fake.res, tracker.next);

    assert.equal(fake.statusCode, 401);
    assert.deepEqual(fake.jsonBody, { error: "not authenticated" });
    assert.equal(tracker.calls, 0);
  });

  it("returns 403 for a valid session with permissions 0", () => {
    const token = signToken(validPayload({ permissions: 0 }), SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    requireAdmin(SECRET)(
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 403);
    assert.deepEqual(fake.jsonBody, { error: "forbidden" });
    assert.equal(tracker.calls, 0);
  });

  it("returns 403 for a valid session with permissions 1", () => {
    const token = signToken(validPayload({ permissions: 1 }), SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    requireAdmin(SECRET)(
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(fake.statusCode, 403);
    assert.deepEqual(fake.jsonBody, { error: "forbidden" });
    assert.equal(tracker.calls, 0);
  });

  it("calls next for a valid session with permissions 2", () => {
    const payload = validPayload({ permissions: 2 });
    const token = signToken(payload, SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    requireAdmin(SECRET)(
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(tracker.calls, 1);
    assert.equal(fake.statusCode, undefined);
    assert.deepEqual(fake.res.locals.session, payload);
  });

  it("calls next for a valid session with permissions 6", () => {
    const payload = validPayload({ permissions: 6 });
    const token = signToken(payload, SECRET);
    const fake = fakeRes();
    const tracker = fakeNext();

    requireAdmin(SECRET)(
      fakeReq(`${SESSION_COOKIE_NAME}=${token}`),
      fake.res,
      tracker.next,
    );

    assert.equal(tracker.calls, 1);
    assert.equal(fake.statusCode, undefined);
    assert.deepEqual(fake.res.locals.session, payload);
  });
});
