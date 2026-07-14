import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDatabase, getDb, openDatabase } from "./index";
import {
  createRequest,
  findActiveDuplicate,
  getRequestById,
  listAllRequests,
  listRequestsByUser,
  updateRequest,
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

  it("create defaults pending/unknown and round-trips seasons + both axes", () => {
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
    assert.equal(fetched!.requestStatus, "pending");
    assert.equal(fetched!.mediaStatus, "unknown");
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

  it("findActiveDuplicate ignores declined and failed request_status", () => {
    const active = createRequest({
      tmdbId: 550,
      mediaType: "movie",
      title: "Fight Club",
      requestedBySeerrId: 1,
      requestedByName: "Tyler",
    });

    const duplicate = findActiveDuplicate(550, "movie");
    assert.notEqual(duplicate, null);
    assert.equal(duplicate!.id, active.id);

    updateRequest(active.id, { requestStatus: "declined" });
    assert.equal(findActiveDuplicate(550, "movie"), null);

    const failed = createRequest({
      tmdbId: 551,
      mediaType: "movie",
      title: "Failed Dup",
      requestedBySeerrId: 1,
      requestedByName: "Tyler",
    });
    assert.notEqual(findActiveDuplicate(551, "movie"), null);
    updateRequest(failed.id, { requestStatus: "failed" });
    assert.equal(findActiveDuplicate(551, "movie"), null);
    assert.equal(findActiveDuplicate(550, "tv"), null);
  });

  it("updateRequest transitions axes independently, sets decided_*, bumps updated_at", async () => {
    const created = createRequest({
      tmdbId: 100,
      mediaType: "movie",
      title: "Test Movie",
      requestedBySeerrId: 5,
      requestedByName: "Admin",
    });

    await new Promise((resolve) => setTimeout(resolve, 2));

    const decidedAt = "2026-07-14T00:00:00.000Z";
    const approved = updateRequest(created.id, {
      requestStatus: "approved",
      mediaStatus: "pending",
      radarrId: 42,
      decidedBy: 1,
      decidedAt,
    });

    assert.equal(approved.requestStatus, "approved");
    assert.equal(approved.mediaStatus, "pending");
    assert.equal(approved.radarrId, 42);
    assert.equal(approved.decidedBy, 1);
    assert.equal(approved.decidedAt, decidedAt);
    assert.notEqual(approved.updatedAt, created.updatedAt);
    assert.equal(approved.createdAt, created.createdAt);

    await new Promise((resolve) => setTimeout(resolve, 2));

    const processing = updateRequest(created.id, {
      mediaStatus: "processing",
    });
    assert.equal(processing.requestStatus, "approved");
    assert.equal(processing.mediaStatus, "processing");
    assert.notEqual(processing.updatedAt, approved.updatedAt);

    const available = updateRequest(created.id, {
      mediaStatus: "available",
    });
    assert.equal(available.requestStatus, "approved");
    assert.equal(available.mediaStatus, "available");
    assert.equal(available.createdAt, created.createdAt);
  });

  it("rejects invalid request_status and media_status via CHECK", () => {
    const db = getDb();
    assert.throws(() => {
      db.prepare(
        `INSERT INTO requests (
          tmdb_id, media_type, title, seasons,
          requested_by_seerr_id, requested_by_name,
          request_status, media_status, created_at, updated_at
        ) VALUES (1, 'movie', 'Bad', NULL, 1, 'A', 'bogus', 'unknown', 't', 't')`,
      ).run();
    });
    assert.throws(() => {
      db.prepare(
        `INSERT INTO requests (
          tmdb_id, media_type, title, seasons,
          requested_by_seerr_id, requested_by_name,
          request_status, media_status, created_at, updated_at
        ) VALUES (1, 'movie', 'Bad', NULL, 1, 'A', 'pending', 'bogus', 't', 't')`,
      ).run();
    });
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
      assert.equal(all[0].requestStatus, "pending");
      assert.equal(all[0].mediaStatus, "unknown");
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
    assert.equal(created.requestStatus, "pending");
    assert.equal(created.mediaStatus, "unknown");
    closeDatabase();
  });
});
