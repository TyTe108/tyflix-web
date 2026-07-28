import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AccessRequestTransitionError,
  createAccessRequestStore,
  type AccessRequest,
} from "./store";

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tyflix-access-req-"));
  return path.join(dir, "access-requests.json");
}

describe("createAccessRequestStore", () => {
  it("starts empty when the file is missing (ENOENT)", async () => {
    const filePath = await tempStorePath();
    const store = await createAccessRequestStore(filePath);
    assert.deepEqual(store.list(), []);
  });

  it("atomically writes and reloads the same records after a restart", async () => {
    const filePath = await tempStorePath();
    const store = await createAccessRequestStore(filePath);

    const created = await store.add({
      email: "  Alice@Example.COM ",
      name: "Alice",
      note: "Ewan's roommate",
      hasPlexAccount: true,
      plexUsername: "alice",
      sourceIp: "203.0.113.9",
    });

    assert.equal(created.email, "alice@example.com");
    assert.equal(created.status, "pending");
    assert.equal(created.sourceIp, "203.0.113.9");
    assert.equal(created.plexUsername, "alice");
    assert.equal(created.decidedAt, null);
    assert.ok(typeof created.id === "string" && created.id.length > 0);
    assert.ok(Number.isInteger(created.createdAt));

    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as AccessRequest[];
    assert.equal(onDisk.length, 1);
    assert.deepEqual(onDisk[0], created);

    // Simulate process restart: new store instance loads from the same file.
    const reloaded = await createAccessRequestStore(filePath);
    assert.deepEqual(reloaded.list(), [created]);
    assert.equal(
      reloaded.findByEmail("  ALICE@example.com ")?.id,
      created.id,
    );
  });

  it("throws on malformed JSON at load (fail-loud)", async () => {
    const filePath = await tempStorePath();
    await writeFile(filePath, "{not-json", "utf8");

    await assert.rejects(
      () => createAccessRequestStore(filePath),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("malformed JSON") &&
        err.message.includes(filePath),
    );
  });

  it("throws when the parent directory does not exist", async () => {
    const filePath = path.join(
      tmpdir(),
      `tyflix-missing-${Date.now()}`,
      "nope",
      "access-requests.json",
    );

    await assert.rejects(
      () => createAccessRequestStore(filePath),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("parent directory does not exist") &&
        err.message.includes(path.dirname(filePath)),
    );
  });

  it("findByEmail normalizes casing and whitespace", async () => {
    const filePath = await tempStorePath();
    const store = await createAccessRequestStore(filePath);
    await store.add({
      email: "bob@example.com",
      name: "Bob",
      note: "hi",
      hasPlexAccount: false,
      sourceIp: null,
    });

    assert.notEqual(store.findByEmail("  BOB@Example.COM "), undefined);
    assert.equal(store.findByEmail("other@example.com"), undefined);
  });

  it("concurrent same-email add() calls produce one record and return it twice", async () => {
    const filePath = await tempStorePath();
    const store = await createAccessRequestStore(filePath);

    const input = {
      email: "race@example.com",
      name: "Racer",
      note: "concurrent",
      hasPlexAccount: false,
      sourceIp: "203.0.113.1",
    };

    const [a, b] = await Promise.all([store.add(input), store.add({
      ...input,
      email: "  RACE@Example.COM ",
      name: "Other Name",
      note: "should not win",
      sourceIp: "203.0.113.2",
    })]);

    assert.equal(store.list().length, 1);
    assert.deepEqual(a, b);
    assert.equal(a.email, "race@example.com");

    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as AccessRequest[];
    assert.equal(onDisk.length, 1);
    assert.deepEqual(onDisk[0], a);
  });

  it("markInvited transitions pending → invited and persists", async () => {
    const filePath = await tempStorePath();
    const store = await createAccessRequestStore(filePath);
    const created = await store.add({
      email: "invite@example.com",
      name: "Invitee",
      note: "friend",
      hasPlexAccount: true,
      sourceIp: null,
    });

    const updated = await store.markInvited(created.id, {
      sectionIds: [122223622, 122223654],
      invitedAt: 1_785_000_100,
    });

    assert.equal(updated.status, "invited");
    assert.equal(updated.invitedAt, 1_785_000_100);
    assert.deepEqual(updated.sectionIds, [122223622, 122223654]);
    assert.ok(updated.decidedAt !== null);
    assert.equal(store.findById(created.id)?.status, "invited");

    const reloaded = await createAccessRequestStore(filePath);
    assert.equal(reloaded.findById(created.id)?.status, "invited");
  });

  it("markDenied transitions pending → denied and never requires Plex fields", async () => {
    const filePath = await tempStorePath();
    const store = await createAccessRequestStore(filePath);
    const created = await store.add({
      email: "deny@example.com",
      name: "Denied",
      note: "nope",
      hasPlexAccount: false,
      sourceIp: null,
    });

    const updated = await store.markDenied(created.id, {
      adminNote: "unknown to me",
    });

    assert.equal(updated.status, "denied");
    assert.equal(updated.adminNote, "unknown to me");
    assert.ok(updated.decidedAt !== null);
    assert.equal(updated.invitedAt, null);
    assert.equal(updated.sectionIds, null);
  });

  it("markInvited/markDenied throw AccessRequestTransitionError when not pending", async () => {
    const filePath = await tempStorePath();
    const store = await createAccessRequestStore(filePath);
    const created = await store.add({
      email: "twice@example.com",
      name: "Twice",
      note: "hi",
      hasPlexAccount: false,
      sourceIp: null,
    });
    await store.markDenied(created.id);

    await assert.rejects(
      () =>
        store.markInvited(created.id, {
          sectionIds: [1],
          invitedAt: 1,
        }),
      (err: unknown) =>
        err instanceof AccessRequestTransitionError &&
        err.attempted === "invited" &&
        err.currentStatus === "denied",
    );
    await assert.rejects(
      () => store.markDenied(created.id),
      (err: unknown) =>
        err instanceof AccessRequestTransitionError &&
        err.attempted === "denied",
    );
  });

  it("markAccepted transitions invited → accepted only", async () => {
    const filePath = await tempStorePath();
    const store = await createAccessRequestStore(filePath);
    const created = await store.add({
      email: "accept@example.com",
      name: "Accept",
      note: "hi",
      hasPlexAccount: true,
      sourceIp: null,
    });

    await assert.rejects(
      () => store.markAccepted(created.id, { acceptedAt: 1_785_000_200 }),
      (err: unknown) =>
        err instanceof AccessRequestTransitionError &&
        err.attempted === "accepted" &&
        err.currentStatus === "pending",
    );

    await store.markInvited(created.id, {
      sectionIds: [122223622],
      invitedAt: 1_785_000_100,
    });
    const accepted = await store.markAccepted(created.id, {
      acceptedAt: 1_785_000_200,
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.acceptedAt, 1_785_000_200);

    const reloaded = await createAccessRequestStore(filePath);
    assert.equal(reloaded.findById(created.id)?.status, "accepted");
  });
});
