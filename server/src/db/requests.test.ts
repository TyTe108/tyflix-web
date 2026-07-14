import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDatabase, openDatabase } from "./index";
import {
  createRequest,
  findActiveDuplicate,
  getRequestById,
  listAllRequests,
  listRequestsByUser,
  updateRequestStatus,
} from "./requests";

describe("requests data access", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "tyflix-db-test-"));
    openDatabase(path.join(tempDir, "test.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("create→getById round-trip preserves seasons JSON", () => {
    const created = createRequest({
      tmdbId: 603,
      mediaType: "tv",
      title: "The Matrix",
      seasons: [1, 2, 3],
      requestedBySeerrId: 42,
      requestedByName: "Tyler",
    });

    const fetched = getRequestById(created.id);
    assert.notEqual(fetched, null);
    assert.equal(fetched!.tmdbId, 603);
    assert.equal(fetched!.mediaType, "tv");
    assert.equal(fetched!.title, "The Matrix");
    assert.deepEqual(fetched!.seasons, [1, 2, 3]);
    assert.equal(fetched!.requestedBySeerrId, 42);
    assert.equal(fetched!.requestedByName, "Tyler");
    assert.equal(fetched!.status, "pending");
  });

  it("listRequestsByUser filters by user and returns newest first", () => {
    const older = createRequest({
      tmdbId: 1,
      mediaType: "movie",
      title: "Older",
      requestedBySeerrId: 10,
      requestedByName: "Alice",
    });
    const newer = createRequest({
      tmdbId: 2,
      mediaType: "movie",
      title: "Newer",
      requestedBySeerrId: 10,
      requestedByName: "Alice",
    });
    createRequest({
      tmdbId: 3,
      mediaType: "movie",
      title: "Other user",
      requestedBySeerrId: 99,
      requestedByName: "Bob",
    });

    const results = listRequestsByUser(10);
    assert.equal(results.length, 2);
    assert.equal(results[0].id, newer.id);
    assert.equal(results[1].id, older.id);
  });

  it("findActiveDuplicate matches tmdb_id+media_type and ignores declined rows", () => {
    const active = createRequest({
      tmdbId: 550,
      mediaType: "movie",
      title: "Fight Club",
      requestedBySeerrId: 1,
      requestedByName: "Tyler",
      status: "pending",
    });

    const duplicate = findActiveDuplicate(550, "movie");
    assert.notEqual(duplicate, null);
    assert.equal(duplicate!.id, active.id);

    updateRequestStatus(active.id, { status: "declined" });

    assert.equal(findActiveDuplicate(550, "movie"), null);
    assert.equal(findActiveDuplicate(550, "tv"), null);
  });

  it("updateRequestStatus transitions status, sets decided_*, and bumps updated_at", async () => {
    const created = createRequest({
      tmdbId: 100,
      mediaType: "movie",
      title: "Test Movie",
      requestedBySeerrId: 5,
      requestedByName: "Admin",
    });

    await new Promise((resolve) => setTimeout(resolve, 2));

    const decidedAt = "2026-07-14T00:00:00.000Z";
    const updated = updateRequestStatus(created.id, {
      status: "approved",
      radarrId: 42,
      decidedBy: 1,
      decidedAt,
    });

    assert.equal(updated.status, "approved");
    assert.equal(updated.radarrId, 42);
    assert.equal(updated.decidedBy, 1);
    assert.equal(updated.decidedAt, decidedAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.equal(updated.createdAt, created.createdAt);
  });

  it("listAllRequests returns all rows newest first", () => {
    const first = createRequest({
      tmdbId: 10,
      mediaType: "movie",
      title: "First",
      requestedBySeerrId: 1,
      requestedByName: "A",
    });
    const second = createRequest({
      tmdbId: 11,
      mediaType: "tv",
      title: "Second",
      seasons: [1],
      requestedBySeerrId: 2,
      requestedByName: "B",
    });

    const all = listAllRequests();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, second.id);
    assert.equal(all[1].id, first.id);
  });
});

describe("openDatabase", () => {
  it("is idempotent across repeated opens", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "tyflix-db-init-"));
    const dbPath = path.join(tempDir, "nested", "tyflix.db");

    try {
      openDatabase(dbPath);
      createRequest({
        tmdbId: 1,
        mediaType: "movie",
        title: "Persisted",
        requestedBySeerrId: 1,
        requestedByName: "Tyler",
      });
      closeDatabase();

      openDatabase(dbPath);
      const all = listAllRequests();
      assert.equal(all.length, 1);
      assert.equal(all[0].title, "Persisted");
    } finally {
      closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("works with :memory: database", () => {
    openDatabase(":memory:");
    const created = createRequest({
      tmdbId: 99,
      mediaType: "movie",
      title: "In Memory",
      requestedBySeerrId: 1,
      requestedByName: "Tyler",
    });
    assert.equal(getRequestById(created.id)?.title, "In Memory");
    closeDatabase();
  });
});
