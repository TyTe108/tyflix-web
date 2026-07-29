// Durable storage for the public /request-access queue. This is the only state
// Tyflix owns; everything else in the app lives in Plex, Seerr or TMDB.
//
// It's a JSON file, not a database, and that's the right size for it. The whole
// dataset is a handful of rows that only I ever read, so the array is held in
// memory and rewritten in full on every change. Two things make that safe:
// writes go through a promise chain so they can't interleave, and each write
// lands in a temp file that gets renamed over the real one, so a crash
// mid-write leaves the previous file intact rather than a truncated one.
//
// Rows move pending to invited to accepted, or pending to denied, and nothing
// else. Illegal moves throw AccessRequestTransitionError instead of quietly
// overwriting a decision. Created in server/src/index.ts when
// ACCESS_REQUESTS_FILE is set; when it isn't, the whole feature stays unmounted.
//
// One thing this does not do is reconcile against Plex. routes/adminAccessRequests.ts
// owns that, because an invite can be accepted without Tyflix ever hearing
// about it.

import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AccessRequestStatus =
  | "pending"
  | "invited" // approved here and the Plex invite went out
  | "accepted" // the person accepted on Plex's side; set by reconciliation
  | "denied";

// One row in the JSON file. Timestamps are epoch seconds, not milliseconds.
export type AccessRequest = {
  id: string; // UUID, generated here
  email: string; // always stored normalized (trimmed, lowercased)
  plexUsername: string | null;
  name: string;
  note: string; // whatever the requester typed in the form
  hasPlexAccount: boolean;
  status: AccessRequestStatus;
  createdAt: number;
  decidedAt: number | null; // when it was invited or denied; drives the 90-day expiry
  invitedAt: number | null;
  acceptedAt: number | null;
  sectionIds: number[] | null; // Plex library sections granted at approval
  adminNote: string | null;
  sourceIp: string | null; // CF-Connecting-IP where available; for abuse triage
};

export type NewAccessRequestInput = {
  email: string;
  name: string;
  note: string;
  hasPlexAccount: boolean;
  plexUsername?: string;
  sourceIp: string | null;
};

export type MarkInvitedInput = {
  sectionIds: number[];
  invitedAt: number; // supplied by the caller, which knows when Plex accepted
  adminNote?: string | null; // omit to keep the existing note; null clears it
};

export type MarkDeniedInput = {
  adminNote?: string; // trimmed; an empty string clears the note
};

export type MarkAcceptedInput = {
  acceptedAt: number; // from Plex, so it reflects when they actually accepted
};

/**
 * Thrown when a status transition is not legal for the current row.
 *
 * Carries the current and attempted statuses so the admin route can answer 409
 * instead of 500. The common cause is two browser tabs acting on the same row.
 */
export class AccessRequestTransitionError extends Error {
  readonly id: string;
  readonly currentStatus: AccessRequestStatus;
  readonly attempted: "invited" | "denied" | "accepted";

  constructor(
    id: string,
    currentStatus: AccessRequestStatus,
    attempted: "invited" | "denied" | "accepted",
  ) {
    super(
      `cannot transition access request ${id} from ${currentStatus} to ${attempted}`,
    );
    this.name = "AccessRequestTransitionError";
    this.id = id;
    this.currentStatus = currentStatus;
    this.attempted = attempted;
  }
}

// Reads are synchronous because the whole array is already in memory. Writes
// are async because they hit the disk.
export type AccessRequestStore = {
  list(): AccessRequest[];
  findByEmail(email: string): AccessRequest | undefined;
  findById(id: string): AccessRequest | undefined;
  add(input: NewAccessRequestInput): Promise<AccessRequest>;
  markInvited(id: string, input: MarkInvitedInput): Promise<AccessRequest>;
  markDenied(id: string, input?: MarkDeniedInput): Promise<AccessRequest>;
  markAccepted(id: string, input: MarkAcceptedInput): Promise<AccessRequest>;
};

/** Denied rows stop blocking resubmits after this many seconds. */
export const DENIED_RESUBMIT_AFTER_SECONDS = 90 * 24 * 60 * 60;

export type AccessRequestStoreOptions = {
  /** Epoch seconds. Injected in tests so denial expiry can be asserted without sleeping. */
  now?: () => number;
};

/**
 * The canonical form of an email everywhere in this feature. Exported because
 * the reconciliation code has to compare Plex's addresses against stored ones
 * the same way.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether an existing row prevents a new submission for the same email.
 * Denied rows with a decidedAt older than 90 days do not block; a null
 * decidedAt on a denied row is treated as still blocking (fail-loud).
 *
 * Both add() and findByEmail() run this, and they have to agree. If the public
 * route's duplicate check were stricter than add()'s, a denial would silently
 * become permanent.
 */
export function blocksEmailResubmit(
  record: AccessRequest,
  nowSeconds: number,
): boolean {
  if (record.status !== "denied") {
    return true;
  }
  if (record.decidedAt === null) {
    return true;
  }
  return nowSeconds - record.decidedAt <= DENIED_RESUBMIT_AFTER_SECONDS;
}

/**
 * Opens the store, loading the file into memory once.
 *
 * Async because of that initial read, so index.ts awaits it during startup.
 * Both failure modes here are deliberately fatal: a missing parent directory
 * usually means the Docker volume didn't mount, and malformed JSON means the
 * file was edited by hand. Starting with an empty queue in either case would
 * quietly drop pending requests.
 *
 * @throws Error when the parent directory is missing or the file exists but
 * isn't a JSON array.
 */
export async function createAccessRequestStore(
  filePath: string,
  options: AccessRequestStoreOptions = {},
): Promise<AccessRequestStore> {
  // The file itself is allowed not to exist yet (first boot). Its directory
  // isn't, since that's the mount point.
  const parentDir = path.dirname(filePath);
  try {
    await access(parentDir);
  } catch {
    throw new Error(
      `ACCESS_REQUESTS_FILE parent directory does not exist: ${parentDir}`,
    );
  }

  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  // The in-memory array is the read path. It's replaced wholesale after each
  // successful write, never mutated in place, so a read that's already in
  // flight keeps seeing a consistent snapshot.
  let records = await loadRecords(filePath);
  let writeChain: Promise<void> = Promise.resolve();

  // Copy out, so a caller iterating the list can't reorder the store.
  function list(): AccessRequest[] {
    return records.slice();
  }

  function findByEmail(email: string): AccessRequest | undefined {
    const normalized = normalizeEmail(email);
    const nowSeconds = now();
    // Same blocking rule as add(): expired denials are invisible here so the
    // public route's short-circuit does not permanently suppress resubmits.
    return records.find(
      (r) => r.email === normalized && blocksEmailResubmit(r, nowSeconds),
    );
  }

  // Unlike findByEmail, this ignores expiry. Admin routes address rows by id
  // and need to see every one of them, including old denials.
  function findById(id: string): AccessRequest | undefined {
    return records.find((r) => r.id === id);
  }

  // The whole concurrency model, in one function. Every mutation queues behind
  // the previous one, so read-modify-write is atomic without a lock: a caller
  // inside `work` is guaranteed nobody else is between reading `records` and
  // replacing it. Note that `done` propagates the rejection to the caller while
  // `writeChain` swallows it, which is what keeps one failed write from
  // poisoning every write after it.
  function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
    const done = writeChain.then(work);
    writeChain = done.then(
      () => undefined,
      () => {
        // Keep the chain alive after a failed write so later submits still run.
      },
    );
    return done;
  }

  /**
   * Records a new submission, or returns the existing row when this email is
   * already in the queue.
   *
   * Idempotent by design rather than by accident. The public form is
   * unauthenticated, so a duplicate submit has to look identical to a first
   * one; if it 409'd, the endpoint would tell a stranger who has already
   * applied.
   */
  async function add(input: NewAccessRequestInput): Promise<AccessRequest> {
    const email = normalizeEmail(input.email);
    const createdAt = now();
    const record: AccessRequest = {
      id: randomUUID(),
      email,
      plexUsername:
        input.plexUsername !== undefined && input.plexUsername.trim() !== ""
          ? input.plexUsername.trim()
          : null,
      name: input.name.trim(),
      note: input.note.trim(),
      hasPlexAccount: input.hasPlexAccount,
      status: "pending",
      createdAt,
      decidedAt: null,
      invitedAt: null,
      acceptedAt: null,
      sectionIds: null,
      adminNote: null,
      sourceIp: input.sourceIp,
    };

    // Serialize writes so concurrent submits cannot interleave and lose a row.
    // Email uniqueness is enforced here (not by the caller): re-check inside
    // the chain so two same-email adds both resolve to the same record.
    return enqueueWrite(async () => {
      const nowSeconds = now();
      const existing = records.find(
        (r) => r.email === email && blocksEmailResubmit(r, nowSeconds),
      );
      if (existing !== undefined) {
        return existing;
      }
      // Disk first, memory second. If the write throws, `records` still matches
      // what's on disk and the caller gets the error.
      const next = [...records, record];
      await atomicWrite(filePath, next);
      records = next;
      return record;
    });
  }

  /**
   * Marks a row approved, after the Plex invite has already gone out.
   *
   * The caller sends the invite first and records it here second, so a failure
   * at this step means Plex and the queue disagree. adminAccessRequests.ts logs
   * that loudly and leans on reconciliation to catch it.
   *
   * @throws AccessRequestTransitionError when the row isn't pending.
   * @throws Error when no row has that id.
   */
  async function markInvited(
    id: string,
    input: MarkInvitedInput,
  ): Promise<AccessRequest> {
    return enqueueWrite(async () => {
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) {
        throw new Error(`access request not found: ${id}`);
      }
      const current = records[index]!;
      if (current.status !== "pending") {
        throw new AccessRequestTransitionError(
          id,
          current.status,
          "invited",
        );
      }

      // This local shadows the injected `now` from the factory and reads the
      // real clock instead. So add() honors an injected clock and this doesn't,
      // which means a test with a fake clock still gets a real-time decidedAt.
      const now = Math.floor(Date.now() / 1000);
      const updated: AccessRequest = {
        ...current,
        status: "invited",
        decidedAt: now,
        invitedAt: input.invitedAt,
        // Copy, so a later mutation of the caller's array can't reach into the
        // stored row.
        sectionIds: input.sectionIds.slice(),
        adminNote:
          input.adminNote !== undefined ? input.adminNote : current.adminNote,
      };
      const next = records.slice();
      next[index] = updated;
      await atomicWrite(filePath, next);
      records = next;
      return updated;
    });
  }

  /**
   * Denies a pending row. Nothing is sent to Plex, so this is the one decision
   * with no external side effect.
   *
   * The decidedAt it writes is what starts the 90-day clock, after which the
   * same email can apply again.
   *
   * @throws AccessRequestTransitionError when the row isn't pending.
   * @throws Error when no row has that id.
   */
  async function markDenied(
    id: string,
    input: MarkDeniedInput = {},
  ): Promise<AccessRequest> {
    return enqueueWrite(async () => {
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) {
        throw new Error(`access request not found: ${id}`);
      }
      const current = records[index]!;
      if (current.status !== "pending") {
        throw new AccessRequestTransitionError(id, current.status, "denied");
      }

      // Same real-clock shadowing as markInvited.
      const now = Math.floor(Date.now() / 1000);
      const updated: AccessRequest = {
        ...current,
        status: "denied",
        decidedAt: now,
        // Three cases: no note given keeps whatever was there, a blank note
        // clears it, and anything else is stored trimmed.
        adminNote:
          input.adminNote !== undefined
            ? input.adminNote.trim() === ""
              ? null
              : input.adminNote.trim()
            : current.adminNote,
      };
      const next = records.slice();
      next[index] = updated;
      await atomicWrite(filePath, next);
      records = next;
      return updated;
    });
  }

  /**
   * Closes the loop when someone accepts their Plex invite.
   *
   * No user-facing action triggers this, and Plex doesn't call us. The only
   * caller is the reconciliation pass in adminAccessRequests.ts, which compares
   * invited rows against Plex on every admin read, so an invite accepted days
   * ago stops showing as outstanding.
   * decidedAt is left alone: the decision was the invite, not the acceptance.
   *
   * @throws AccessRequestTransitionError when the row isn't invited.
   * @throws Error when no row has that id.
   */
  async function markAccepted(
    id: string,
    input: MarkAcceptedInput,
  ): Promise<AccessRequest> {
    return enqueueWrite(async () => {
      const index = records.findIndex((r) => r.id === id);
      if (index < 0) {
        throw new Error(`access request not found: ${id}`);
      }
      const current = records[index]!;
      if (current.status !== "invited") {
        throw new AccessRequestTransitionError(
          id,
          current.status,
          "accepted",
        );
      }

      const updated: AccessRequest = {
        ...current,
        status: "accepted",
        acceptedAt: input.acceptedAt,
      };
      const next = records.slice();
      next[index] = updated;
      await atomicWrite(filePath, next);
      records = next;
      return updated;
    });
  }

  return {
    list,
    findByEmail,
    findById,
    add,
    markInvited,
    markDenied,
    markAccepted,
  };
}

// Reads the file at startup. A missing file is the first-boot case and yields
// an empty queue; anything else is loud. Note the cast at the end: rows are
// trusted to match AccessRequest without per-field validation, on the grounds
// that this process is the only thing that ever writes them.
async function loadRecords(filePath: string): Promise<AccessRequest[]> {
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
      `ACCESS_REQUESTS_FILE contains malformed JSON (${filePath}): ${detail}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `ACCESS_REQUESTS_FILE must contain a JSON array (${filePath})`,
    );
  }

  return parsed as AccessRequest[];
}

// Write-then-rename, so the file is never observed half-written. rename() is
// atomic within a filesystem, which is why the temp file is deliberately placed
// in the same directory rather than in the OS temp dir.
async function atomicWrite(
  filePath: string,
  records: AccessRequest[],
): Promise<void> {
  const dir = path.dirname(filePath);
  // Dotfile prefix keeps it out of casual listings; pid plus a UUID keeps two
  // writers from picking the same name.
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  // Pretty-printed with a trailing newline. It's a file I might open in an
  // editor, so readability beats compactness at this size.
  const payload = `${JSON.stringify(records, null, 2)}\n`;
  await writeFile(tempPath, payload, "utf8");
  await rename(tempPath, filePath);
}

// Narrows a caught error enough to read `.code`, which is how the missing-file
// case is told apart from a real read failure.
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
