// Durable per-user session revocation. When a user logs out, every cookie
// issued for that Seerr user before the logout becomes invalid immediately —
// not just the browser that called logout.
//
// This is deliberately per-user, not per-cookie. The session cookie has no
// session identifier today (only seerrUserId + iat/exp), so there is nothing
// finer-grained to revoke against. Logging out therefore signs that user out
// everywhere. Adding a per-session id is out of scope.
//
// Storage mirrors accessRequests/store.ts: a JSON file loaded into memory at
// construction, synchronous in-memory reads, writes serialized through a
// promise chain and committed via atomic temp-file-rename. Construction is
// fatal if the parent directory is missing (usually a missing Docker volume).
//
// Contract for "revoked": session.iat < validAfter (strict less-than, both in
// epoch seconds). A session issued in the same second as the logout
// (iat === validAfter) is VALID, so logout-then-immediate-re-login works.

import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** One record per user who has ever logged out. Timestamps are epoch seconds. */
export type SessionRevocationRecord = {
  seerrUserId: number;
  /** Sessions with iat strictly less than this are revoked. */
  validAfter: number;
};

export type SessionRevocationStore = {
  /**
   * Whether a session for `seerrUserId` issued at `iat` (epoch seconds) is
   * revoked. Uses strict less-than: `iat < validAfter`. Never-revoked users
   * always return false. `iat === validAfter` is not revoked.
   */
  isRevoked(seerrUserId: number, iat: number): boolean;
  /**
   * Marks every session for `seerrUserId` with iat strictly before "now"
   * (epoch seconds) as revoked. Persists before resolving. Throws on write
   * failure — callers must not treat a failed revoke as success.
   */
  revokeSessionsBefore(seerrUserId: number): Promise<void>;
};

export type SessionRevocationStoreOptions = {
  /** Epoch seconds. Injected in tests so same-second edge cases are deterministic. */
  now?: () => number;
};

/**
 * Opens the store, loading the file into memory once.
 *
 * @throws Error when the parent directory is missing or the file exists but
 * isn't a JSON array.
 */
export async function createSessionRevocationStore(
  filePath: string,
  options: SessionRevocationStoreOptions = {},
): Promise<SessionRevocationStore> {
  const parentDir = path.dirname(filePath);
  try {
    await access(parentDir);
  } catch {
    throw new Error(
      `SESSION_REVOCATION_FILE parent directory does not exist: ${parentDir}`,
    );
  }

  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let records = await loadRecords(filePath);
  let writeChain: Promise<void> = Promise.resolve();

  function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const done = writeChain.then(work);
    writeChain = done.then(
      () => undefined,
      () => {
        // Keep the chain alive after a failed write so later revokes still run.
      },
    );
    return done;
  }

  /**
   * True when this user's validAfter exists and iat is strictly less than it.
   * Units: epoch seconds. Never-revoked users are never revoked.
   */
  function isRevoked(seerrUserId: number, iat: number): boolean {
    const record = records.find((r) => r.seerrUserId === seerrUserId);
    if (record === undefined) {
      return false;
    }
    return iat < record.validAfter;
  }

  /**
   * Sets this user's validAfter to now (epoch seconds). Sessions with
   * iat < that value are revoked; iat === validAfter remains valid.
   */
  async function revokeSessionsBefore(seerrUserId: number): Promise<void> {
    const validAfter = now();
    return enqueueWrite(async () => {
      const index = records.findIndex((r) => r.seerrUserId === seerrUserId);
      const updated: SessionRevocationRecord = { seerrUserId, validAfter };
      const next = records.slice();
      if (index < 0) {
        next.push(updated);
      } else {
        next[index] = updated;
      }
      await atomicWrite(filePath, next);
      records = next;
    });
  }

  return { isRevoked, revokeSessionsBefore };
}

async function loadRecords(
  filePath: string,
): Promise<SessionRevocationRecord[]> {
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
      `SESSION_REVOCATION_FILE contains malformed JSON (${filePath}): ${detail}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `SESSION_REVOCATION_FILE must contain a JSON array (${filePath})`,
    );
  }

  return parsed as SessionRevocationRecord[];
}

async function atomicWrite(
  filePath: string,
  records: SessionRevocationRecord[],
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
