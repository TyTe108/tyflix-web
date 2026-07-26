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

export type AccessRequestStore = {
  list(): AccessRequest[];
  findByEmail(email: string): AccessRequest | undefined;
  add(input: NewAccessRequestInput): Promise<AccessRequest>;
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
    const done: Promise<AccessRequest> = writeChain.then(async () => {
      const existing = records.find((r) => r.email === email);
      if (existing !== undefined) {
        return existing;
      }
      const next = [...records, record];
      await atomicWrite(filePath, next);
      records = next;
      return record;
    });
    writeChain = done.then(
      () => undefined,
      () => {
        // Keep the chain alive after a failed write so later submits still run.
      },
    );
    return await done;
  }

  return { list, findByEmail, add };
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
