import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  TokenDecryptError,
  isAdmin,
  issueSession,
  readPlexToken,
  readSession,
} from "./session";

const PLEX_TOKEN = "xToKeN-abc123-DEF456";

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
    const badSig = `${sigPart[0] === "A" ? "B" : "A"}${sigPart.slice(1)}`;
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

describe("encrypted Plex token", () => {
  it("round-trips: encrypts on issue and decrypts back to the original", () => {
    const { res, cookies } = fakeRes();
    issueSession(
      res,
      { ...sessionData, plexToken: PLEX_TOKEN },
      { secret: SECRET, secure: false },
    );

    const session = readSession(
      fakeReq(`${SESSION_COOKIE_NAME}=${cookies[0].value}`),
      SECRET,
    );
    assert.notEqual(session, null);
    assert.equal(readPlexToken(session!, SECRET), PLEX_TOKEN);
  });

  it("does not embed the plaintext token in the signed cookie", () => {
    const { res, cookies } = fakeRes();
    issueSession(
      res,
      { ...sessionData, plexToken: PLEX_TOKEN },
      { secret: SECRET, secure: false },
    );

    const cookieValue = cookies[0].value;
    assert.equal(cookieValue.includes(PLEX_TOKEN), false);

    // The decoded payload segment must not leak the token either.
    const payloadPart = cookieValue.split(".")[0];
    const json = Buffer.from(payloadPart, "base64url").toString("utf8");
    assert.equal(json.includes(PLEX_TOKEN), false);
  });

  it("returns null when the session carries no token blob", () => {
    const { res, cookies } = fakeRes();
    issueSession(res, sessionData, { secret: SECRET, secure: false });

    const session = readSession(
      fakeReq(`${SESSION_COOKIE_NAME}=${cookies[0].value}`),
      SECRET,
    );
    assert.notEqual(session, null);
    assert.equal(readPlexToken(session!, SECRET), null);
  });

  it("throws TokenDecryptError when the token blob is tampered", () => {
    const { res, cookies } = fakeRes();
    const issued = issueSession(
      res,
      { ...sessionData, plexToken: PLEX_TOKEN },
      { secret: SECRET, secure: false },
    );
    assert.equal(typeof issued.enc, "string");

    // Flip a fully-significant byte inside the blob (the IV region, at the very
    // front) rather than the trailing base64url char, avoiding unpadded-
    // signature flakiness. Tampering the IV breaks GCM authentication.
    const raw = Buffer.from(issued.enc!, "base64url");
    raw[0] = raw[0] ^ 0xff;
    const tampered: typeof issued = {
      ...issued,
      enc: raw.toString("base64url"),
    };

    assert.throws(
      () => readPlexToken(tampered, SECRET),
      (err: unknown) => err instanceof TokenDecryptError,
    );
  });
});
