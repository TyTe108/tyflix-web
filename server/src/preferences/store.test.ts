import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createUserPreferencesStore } from "./store";

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tyflix-user-prefs-"));
  return path.join(dir, "user-preferences.json");
}

describe("createUserPreferencesStore", () => {
  it("returns the default preferences for a user with no stored row", async () => {
    const store = await createUserPreferencesStore(await tempStorePath());
    assert.deepEqual(store.get(7), { fullscreenOnPlay: true });
  });

  it("writing false and reading it back returns false", async () => {
    const store = await createUserPreferencesStore(await tempStorePath());

    const written = await store.set(7, { fullscreenOnPlay: false });
    assert.deepEqual(written, { fullscreenOnPlay: false });
    assert.deepEqual(store.get(7), { fullscreenOnPlay: false });
  });

  it("persists across a second store instance on the same file", async () => {
    const filePath = await tempStorePath();
    const store = await createUserPreferencesStore(filePath);

    await store.set(7, { fullscreenOnPlay: false });

    const reloaded = await createUserPreferencesStore(filePath);
    assert.deepEqual(reloaded.get(7), { fullscreenOnPlay: false });
  });

  it("throws when the parent directory does not exist", async () => {
    const filePath = path.join(
      tmpdir(),
      `tyflix-missing-prefs-${Date.now()}`,
      "nope",
      "user-preferences.json",
    );

    await assert.rejects(
      () => createUserPreferencesStore(filePath),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("parent directory does not exist") &&
        err.message.includes(path.dirname(filePath)),
    );
  });

  it("throws on malformed JSON at load and does not start empty", async () => {
    const filePath = await tempStorePath();
    await writeFile(filePath, "{not-json", "utf8");

    await assert.rejects(
      () => createUserPreferencesStore(filePath),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("malformed JSON") &&
        err.message.includes(filePath),
    );
  });

  it("throws when the file contains JSON that is not an array", async () => {
    const filePath = await tempStorePath();
    await writeFile(filePath, '{"fullscreenOnPlay":true}\n', "utf8");

    await assert.rejects(
      () => createUserPreferencesStore(filePath),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes("JSON array") &&
        err.message.includes(filePath),
    );
  });

  it("overlapping writes for different users both land", async () => {
    const store = await createUserPreferencesStore(await tempStorePath());

    const [a, b] = await Promise.all([
      store.set(7, { fullscreenOnPlay: false }),
      store.set(8, { fullscreenOnPlay: false }),
    ]);

    assert.deepEqual(a, { fullscreenOnPlay: false });
    assert.deepEqual(b, { fullscreenOnPlay: false });
    assert.deepEqual(store.get(7), { fullscreenOnPlay: false });
    assert.deepEqual(store.get(8), { fullscreenOnPlay: false });
  });

  it("overlapping writes for the same user both resolve with one row", async () => {
    const filePath = await tempStorePath();
    const store = await createUserPreferencesStore(filePath);
    await store.set(7, { fullscreenOnPlay: false });

    // Second call's empty patch must merge over the first call's write, not the
    // pre-race false. That only holds when get() runs inside enqueueWrite.
    const [first, second] = await Promise.all([
      store.set(7, { fullscreenOnPlay: true }),
      store.set(7, {}),
    ]);

    assert.deepEqual(first, { fullscreenOnPlay: true });
    assert.deepEqual(second, { fullscreenOnPlay: true });
    assert.deepEqual(store.get(7), { fullscreenOnPlay: true });

    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as Array<{
      seerrUserId: number;
      fullscreenOnPlay: boolean;
    }>;
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0]!.seerrUserId, 7);
    assert.equal(onDisk[0]!.fullscreenOnPlay, true);
  });
});
