import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import type {
  AccessRequest,
  NewAccessRequestInput,
} from "../accessRequests/store";
import { normalizeEmail } from "../accessRequests/store";
import { createAccessRequestsRouter } from "./accessRequests";

type FakeStore = {
  records: AccessRequest[];
  addCalls: NewAccessRequestInput[];
  failNextAdd?: Error;
  list(): AccessRequest[];
  findByEmail(email: string): AccessRequest | undefined;
  add(input: NewAccessRequestInput): Promise<AccessRequest>;
};

function createFakeStore(
  initial: AccessRequest[] = [],
): FakeStore {
  const store: FakeStore = {
    records: [...initial],
    addCalls: [],
    list() {
      return this.records.slice();
    },
    findByEmail(email: string) {
      const normalized = normalizeEmail(email);
      return this.records.find((r) => r.email === normalized);
    },
    async add(input: NewAccessRequestInput) {
      this.addCalls.push(input);
      if (this.failNextAdd) {
        const err = this.failNextAdd;
        this.failNextAdd = undefined;
        throw err;
      }
      const record: AccessRequest = {
        id: `id-${this.records.length + 1}`,
        email: normalizeEmail(input.email),
        plexUsername: input.plexUsername ?? null,
        name: input.name,
        note: input.note,
        hasPlexAccount: input.hasPlexAccount,
        status: "pending",
        createdAt: 1_785_000_000,
        decidedAt: null,
        invitedAt: null,
        acceptedAt: null,
        sectionIds: null,
        adminNote: null,
        sourceIp: input.sourceIp,
      };
      this.records.push(record);
      return record;
    },
  };
  return store;
}

function buildApp(store: FakeStore): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/access-requests", createAccessRequestsRouter({ store }));
  return app;
}

async function post(
  app: express.Express,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    return await fetch(`http://127.0.0.1:${address.port}/api/access-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

const validBody = {
  email: "someone@example.com",
  name: "Some One",
  note: "Ewan's roommate",
  hasPlexAccount: true,
  plexUsername: "someone",
};

describe("POST /api/access-requests", () => {
  it("returns 202 and stores a pending record with sourceIp from cf-connecting-ip", async () => {
    const store = createFakeStore();
    const app = buildApp(store);

    const response = await post(app, validBody, {
      "cf-connecting-ip": "203.0.113.9",
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "received" });
    assert.equal(store.records.length, 1);
    assert.equal(store.records[0]?.email, "someone@example.com");
    assert.equal(store.records[0]?.status, "pending");
    assert.equal(store.records[0]?.sourceIp, "203.0.113.9");
    assert.equal(store.addCalls[0]?.sourceIp, "203.0.113.9");
  });

  it("is idempotent by email: same 202, no second record", async () => {
    const store = createFakeStore();
    const app = buildApp(store);

    const first = await post(app, validBody);
    assert.equal(first.status, 202);
    const firstBody = await first.text();
    assert.equal(firstBody, JSON.stringify({ status: "received" }));

    const second = await post(app, {
      ...validBody,
      email: "  Someone@Example.COM ",
      name: "Different Name",
      note: "different note",
    });
    assert.equal(second.status, 202);
    assert.equal(await second.text(), firstBody);
    assert.equal(store.records.length, 1);
    assert.equal(store.addCalls.length, 1);
  });

  it("honeypot: non-empty website returns 202 and stores nothing", async () => {
    const store = createFakeStore();
    const app = buildApp(store);

    const response = await post(app, { ...validBody, website: "http://spam" });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "received" });
    assert.equal(store.records.length, 0);
    assert.equal(store.addCalls.length, 0);
  });

  it("rejects missing email", async () => {
    const store = createFakeStore();
    const app = buildApp(store);
    const { email: _e, ...rest } = validBody;
    const response = await post(app, rest);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /email/i);
    assert.equal(store.records.length, 0);
  });

  it("rejects malformed email", async () => {
    const store = createFakeStore();
    const app = buildApp(store);
    const response = await post(app, { ...validBody, email: "not-an-email" });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /email/i);
    assert.equal(store.records.length, 0);
  });

  it("rejects missing name", async () => {
    const store = createFakeStore();
    const app = buildApp(store);
    const response = await post(app, { ...validBody, name: "  " });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /name/i);
  });

  it("rejects missing note", async () => {
    const store = createFakeStore();
    const app = buildApp(store);
    const response = await post(app, { ...validBody, note: "" });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /note/i);
  });

  it("rejects hasPlexAccount when not a boolean", async () => {
    const store = createFakeStore();
    const app = buildApp(store);
    const response = await post(app, {
      ...validBody,
      hasPlexAccount: "yes",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /hasPlexAccount/i);
  });

  it("rejects fields over their length caps", async () => {
    const store = createFakeStore();
    const app = buildApp(store);

    const emailRes = await post(app, {
      ...validBody,
      email: `${"a".repeat(250)}@example.com`,
    });
    assert.equal(emailRes.status, 400);
    assert.match(
      ((await emailRes.json()) as { error: string }).error,
      /email/i,
    );

    const nameRes = await post(app, {
      ...validBody,
      name: "n".repeat(81),
    });
    assert.equal(nameRes.status, 400);
    assert.match(((await nameRes.json()) as { error: string }).error, /name/i);

    const noteRes = await post(app, {
      ...validBody,
      note: "n".repeat(281),
    });
    assert.equal(noteRes.status, 400);
    assert.match(((await noteRes.json()) as { error: string }).error, /note/i);

    const plexRes = await post(app, {
      ...validBody,
      plexUsername: "p".repeat(65),
    });
    assert.equal(plexRes.status, 400);
    assert.match(
      ((await plexRes.json()) as { error: string }).error,
      /plexUsername/i,
    );

    assert.equal(store.records.length, 0);
  });

  it("returns 500 when the store write fails", async () => {
    const store = createFakeStore();
    store.failNextAdd = new Error("disk full");
    const app = buildApp(store);

    const response = await post(app, validBody);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "failed to store access request",
    });
    assert.equal(store.records.length, 0);
  });
});
