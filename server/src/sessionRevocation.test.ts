import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createSessionRevocationStore } from "./sessionRevocation";

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tyflix-session-rev-"));
  return path.join(dir, "session-revocation.json");
}

describe("createSessionRevocationStore", () => {
  it("never-revoked user is not revoked", async () => {
    const store = await createSessionRevocationStore(await tempStorePath());
    assert.equal(store.isRevoked(7, 1_700_000_000), false);
  });

  it("revoked user's pre-revocation iat is revoked (strict less-than)", async () => {
    let now = 1_700_000_100;
    const store = await createSessionRevocationStore(await tempStorePath(), {
      now: () => now,
    });

    await store.revokeSessionsBefore(7);

    // iat < validAfter → revoked
    assert.equal(store.isRevoked(7, now - 1), true);
    // iat === validAfter → valid (same-second re-login)
    assert.equal(store.isRevoked(7, now), false);
    // iat > validAfter → valid
    assert.equal(store.isRevoked(7, now + 1), false);
  });

  it("a different user is unaffected by another user's revocation", async () => {
    let now = 1_700_000_200;
    const store = await createSessionRevocationStore(await tempStorePath(), {
      now: () => now,
    });

    await store.revokeSessionsBefore(7);

    assert.equal(store.isRevoked(7, now - 1), true);
    assert.equal(store.isRevoked(8, now - 1), false);
  });

  it("persists revocation across a second store instance on the same file", async () => {
    const filePath = await tempStorePath();
    let now = 1_700_000_300;
    const store = await createSessionRevocationStore(filePath, {
      now: () => now,
    });

    await store.revokeSessionsBefore(7);

    const reloaded = await createSessionRevocationStore(filePath);
    assert.equal(reloaded.isRevoked(7, now - 1), true);
    assert.equal(reloaded.isRevoked(7, now), false);
  });

  it("throws when the parent directory does not exist", async () => {
    const filePath = path.join(
      tmpdir(),
      `tyflix-missing-rev-${Date.now()}`,
      "nope",
      "session-revocation.json",
    );

    await assert.rejects(
      () => createSessionRevocationStore(filePath),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("parent directory does not exist") &&
        err.message.includes(path.dirname(filePath)),
    );
  });

  it("a later revoke advances validAfter", async () => {
    let now = 1_700_000_400;
    const store = await createSessionRevocationStore(await tempStorePath(), {
      now: () => now,
    });

    await store.revokeSessionsBefore(7);
    assert.equal(store.isRevoked(7, now), false);

    now = 1_700_000_500;
    await store.revokeSessionsBefore(7);
    assert.equal(store.isRevoked(7, 1_700_000_400), true);
    assert.equal(store.isRevoked(7, 1_700_000_500), false);
  });

  it("rejects when the write fails and does not advance in-memory state", async () => {
    // Open against a valid directory, then remove it so atomicWrite's writeFile
    // fails with ENOENT. Don't chmod — platform-dependent.
    const dir = await mkdtemp(path.join(tmpdir(), "tyflix-session-rev-fail-"));
    const filePath = path.join(dir, "session-revocation.json");
    let now = 1_700_000_600;
    const store = await createSessionRevocationStore(filePath, {
      now: () => now,
    });

    await rm(dir, { recursive: true, force: true });

    await assert.rejects(() => store.revokeSessionsBefore(7));

    // records is only replaced after atomicWrite resolves — a failed write
    // must leave in-memory state matching what was durably written (nothing).
    assert.equal(store.isRevoked(7, now - 1), false);
  });
});
