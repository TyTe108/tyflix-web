// Durable per-user preference store. Holds settings that aren't session data —
// today just fullscreenOnPlay — keyed by Seerr user id.
//
// Constructed once in index.ts from config.userPreferencesFile (always on, not
// feature-flagged). Auth's GET /me reads it synchronously; PATCH /api/me/preferences
// writes through set().
//
// Storage mirrors sessionRevocation.ts: JSON file loaded into memory at
// construction, synchronous in-memory reads, writes serialized through a
// promise chain and committed via atomic temp-file-rename. Construction is
// fatal if the parent directory is missing or the file is malformed.

import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Preferences the client can read and patch for the signed-in user. */
export type UserPreferences = {
  fullscreenOnPlay: boolean;
};

/**
 * Defaults applied when a user has no stored row, and when a stored row is
 * missing a key added in a later version.
 */
export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  fullscreenOnPlay: true,
};

/** One row in the JSON file. Extra preference keys may appear over time. */
type UserPreferencesRecord = {
  seerrUserId: number;
} & Partial<UserPreferences>;

export type UserPreferencesStore = {
  /**
   * Current preferences for `seerrUserId`, with defaults filling any gaps.
   * Synchronous: the file is already in memory.
   */
  get(seerrUserId: number): UserPreferences;
  /**
   * Merges `patch` over the current value (defaults included), persists, and
   * resolves with the merged result.
   *
   * @throws Error on write failure — callers must not treat a failed set as
   * success.
   */
  set(
    seerrUserId: number,
    patch: Partial<UserPreferences>,
  ): Promise<UserPreferences>;
};

/**
 * Opens the store, loading the file into memory once.
 *
 * @throws Error when the parent directory is missing, the file exists but
 * isn't valid JSON, or the JSON isn't an array.
 */
export async function createUserPreferencesStore(
  filePath: string,
): Promise<UserPreferencesStore> {
  const parentDir = path.dirname(filePath);
  try {
    await access(parentDir);
  } catch {
    throw new Error(
      `USER_PREFERENCES_FILE parent directory does not exist: ${parentDir}`,
    );
  }

  let records = await loadRecords(filePath);
  let writeChain: Promise<void> = Promise.resolve();

  function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const done = writeChain.then(work);
    writeChain = done.then(
      () => undefined,
      () => {
        // Keep the chain alive after a failed write so later sets still run.
      },
    );
    return done;
  }

  function get(seerrUserId: number): UserPreferences {
    const record = records.find((r) => r.seerrUserId === seerrUserId);
    if (record === undefined) {
      return { ...DEFAULT_USER_PREFERENCES };
    }
    return { ...DEFAULT_USER_PREFERENCES, ...preferenceFields(record) };
  }

  async function set(
    seerrUserId: number,
    patch: Partial<UserPreferences>,
  ): Promise<UserPreferences> {
    return enqueueWrite(async () => {
      const merged: UserPreferences = { ...get(seerrUserId), ...patch };
      const updated: UserPreferencesRecord = { seerrUserId, ...merged };
      const index = records.findIndex((r) => r.seerrUserId === seerrUserId);
      const next = records.slice();
      if (index < 0) {
        next.push(updated);
      } else {
        next[index] = updated;
      }
      await atomicWrite(filePath, next);
      records = next;
      return merged;
    });
  }

  return { get, set };
}

// A non-boolean fullscreenOnPlay in the file is dropped and the default fills
// in, same idea as WatchPage treating corrupt subtitle preference JSON as "no
// preference": throwing here would 500 every /me for that user over our own
// bad row, and the fix is to rewrite the file, not to brick the session check.
function preferenceFields(
  record: UserPreferencesRecord,
): Partial<UserPreferences> {
  const out: Partial<UserPreferences> = {};
  if (typeof record.fullscreenOnPlay === "boolean") {
    out.fullscreenOnPlay = record.fullscreenOnPlay;
  }
  return out;
}

async function loadRecords(filePath: string): Promise<UserPreferencesRecord[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `USER_PREFERENCES_FILE contains malformed JSON (${filePath}): ${detail}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `USER_PREFERENCES_FILE must contain a JSON array (${filePath})`,
    );
  }

  return parsed as UserPreferencesRecord[];
}

async function atomicWrite(
  filePath: string,
  records: UserPreferencesRecord[],
): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const payload = `${JSON.stringify(records, null, 2)}\n`;
  await writeFile(tempPath, payload, "utf8");
  await rename(tempPath, filePath);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
