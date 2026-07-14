import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  isAdmin,
  issueSession,
  readSession,
} from "./session";

const SECRET = "sixteen-chars!!!";

const sessionData = {
  seerrUserId: 7,
  plexId: 42,
  plexUsername: "tyler",
  displayName: "Tyler",
  avatar: "https://example.com/a.png",
  permissions: 2,
};

function signToken(payload: Record<string, unknown>, secret: string): string {
  const json = JSON.stringify(payload);
  const payloadPart = Buffer.from(json, "utf8").toString("base64url");
  const sigPart = createHmac("sha256", secret)
    .update(json)
    .digest("base64url");
  return `${payloadPart}.${sigPart}`;
}

function fakeRes() {
  const cookies: Array<{
    name: string;
    value: string;
    opts: Record<string, unknown>;
  }> = [];
  const res = {
    cookie(name: string, value: string, opts: Record<string, unknown>) {
      cookies.push({ name, value, opts });
    },
  };
  return { res: res as unknown as Response, cookies };
}

function fakeReq(cookieHeader?: string): Request {
  return {
    headers: cookieHeader === undefined ? {} : { cookie: cookieHeader },
  } as Request;
}

describe("isAdmin", () => {
  it("recognizes the ADMIN bit", () => {
    assert.equal(isAdmin(2), true);
    assert.equal(isAdmin(0), false);
    assert.equal(isAdmin(6), true);
    assert.equal(isAdmin(32), false);
  });
});

describe("session round-trip", () => {
  it("issues a cookie that readSession can verify", () => {
    const { res, cookies } = fakeRes();
    const before = Math.floor(Date.now() / 1000);
    const issued = issueSession(res, sessionData, {
      secret: SECRET,
      secure: false,
    });
    const after = Math.floor(Date.now() / 1000);

    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, SESSION_COOKIE_NAME);
    assert.equal(cookies[0].opts.httpOnly, true);
    assert.equal(cookies[0].opts.secure, false);

    assert.deepEqual(
      {
        seerrUserId: issued.seerrUserId,
        plexId: issued.plexId,
        plexUsername: issued.plexUsername,
        displayName: issued.displayName,
        avatar: issued.avatar,
        permissions: issued.permissions,
      },
      sessionData,
    );
    assert.equal(typeof issued.iat, "number");
    assert.equal(typeof issued.exp, "number");
    assert.ok(issued.iat >= before && issued.iat <= after);
    assert.equal(issued.exp, issued.iat + SESSION_TTL_SECONDS);

    const read = readSession(
      fakeReq(`${SESSION_COOKIE_NAME}=${cookies[0].value}`),
      SECRET,
    );
    assert.deepEqual(read, issued);
  });
});

describe("readSession rejects invalid tokens", () => {
  it("returns null when there is no cookie", () => {
    assert.equal(readSession(fakeReq(), SECRET), null);
    assert.equal(readSession(fakeReq("other=1"), SECRET), null);
  });

  it("returns null for a token verified with a different secret", () => {
    const { res, cookies } = fakeRes();
    issueSession(res, sessionData, { secret: SECRET, secure: false });
    assert.equal(
      readSession(
        fakeReq(`${SESSION_COOKIE_NAME}=${cookies[0].value}`),
        "different-secret!",
      ),
      null,
    );
  });

  it("returns null when the payload segment is altered", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      { ...sessionData, iat: now, exp: now + SESSION_TTL_SECONDS },
      SECRET,
    );
    const [payloadPart, sigPart] = token.split(".");
    const alteredPayload = Buffer.from(
      JSON.stringify({
        ...sessionData,
        plexId: 999,
        iat: now,
        exp: now + SESSION_TTL_SECONDS,
      }),
      "utf8",
    ).toString("base64url");
    assert.notEqual(alteredPayload, payloadPart);
    assert.equal(
      readSession(
        fakeReq(`${SESSION_COOKIE_NAME}=${alteredPayload}.${sigPart}`),
        SECRET,
      ),
      null,
    );
  });

  it("returns null when the signature segment is altered", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      { ...sessionData, iat: now, exp: now + SESSION_TTL_SECONDS },
      SECRET,
    );
    const [payloadPart, sigPart] = token.split(".");
    const badSig = `${sigPart.slice(0, -1)}${sigPart.endsWith("a") ? "b" : "a"}`;
    assert.equal(
      readSession(
        fakeReq(`${SESSION_COOKIE_NAME}=${payloadPart}.${badSig}`),
        SECRET,
      ),
      null,
    );
  });

  it("returns null for an expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      { ...sessionData, iat: now - 100, exp: now - 1 },
      SECRET,
    );
    assert.equal(
      readSession(fakeReq(`${SESSION_COOKIE_NAME}=${token}`), SECRET),
      null,
    );
  });
});
