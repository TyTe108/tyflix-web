import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
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
});
