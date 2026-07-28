import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type AccessRequestStatus =
  | "pending"
  | "invited"
  | "accepted"
  | "denied";

export type AccessRequest = {
  id: string;
  email: string;
  plexUsername: string | null;
  name: string;
  note: string;
  hasPlexAccount: boolean;
  status: AccessRequestStatus;
  createdAt: number;
  decidedAt: number | null;
  invitedAt: number | null;
  acceptedAt: number | null;
  sectionIds: number[] | null;
  adminNote: string | null;
  sourceIp: string | null;
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
  invitedAt: number;
  adminNote?: string | null;
};

export type MarkDeniedInput = {
  adminNote?: string;
};

export type MarkAcceptedInput = {
  acceptedAt: number;
};

/** Thrown when a status transition is not legal for the current row. */
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

export type AccessRequestStore = {
  list(): AccessRequest[];
  findByEmail(email: string): AccessRequest | undefined;
  findById(id: string): AccessRequest | undefined;
  add(input: NewAccessRequestInput): Promise<AccessRequest>;
  markInvited(id: string, input: MarkInvitedInput): Promise<AccessRequest>;
  markDenied(id: string, input?: MarkDeniedInput): Promise<AccessRequest>;
  markAccepted(id: string, input: MarkAcceptedInput): Promise<AccessRequest>;
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createAccessRequestStore(
  filePath: string,
): Promise<AccessRequestStore> {
  const parentDir = path.dirname(filePath);
  try {
    await access(parentDir);
  } catch {
    throw new Error(
      `ACCESS_REQUESTS_FILE parent directory does not exist: ${parentDir}`,
    );
  }

  let records = await loadRecords(filePath);
  let writeChain: Promise<void> = Promise.resolve();

  function list(): AccessRequest[] {
    return records.slice();
  }

  function findByEmail(email: string): AccessRequest | undefined {
    const normalized = normalizeEmail(email);
    return records.find((r) => r.email === normalized);
  }

  function findById(id: string): AccessRequest | undefined {
    return records.find((r) => r.id === id);
  }

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

  async function add(input: NewAccessRequestInput): Promise<AccessRequest> {
    const email = normalizeEmail(input.email);
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
      createdAt: Math.floor(Date.now() / 1000),
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
      const existing = records.find((r) => r.email === email);
      if (existing !== undefined) {
        return existing;
      }
      const next = [...records, record];
      await atomicWrite(filePath, next);
      records = next;
      return record;
    });
  }

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

      const now = Math.floor(Date.now() / 1000);
      const updated: AccessRequest = {
        ...current,
        status: "invited",
        decidedAt: now,
        invitedAt: input.invitedAt,
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

      const now = Math.floor(Date.now() / 1000);
      const updated: AccessRequest = {
        ...current,
        status: "denied",
        decidedAt: now,
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

async function atomicWrite(
  filePath: string,
  records: AccessRequest[],
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
