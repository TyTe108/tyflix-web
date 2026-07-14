import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// If a stale data/tyflix.db from the single-status 5.1 schema exists locally,
// delete it so CREATE TABLE IF NOT EXISTS builds the two-axis shape. The file
// is gitignored and throwaway; tests use fresh temp / :memory: DBs.
const REQUESTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  title TEXT NOT NULL,
  seasons TEXT,
  requested_by_seerr_id INTEGER NOT NULL,
  requested_by_name TEXT NOT NULL,
  request_status TEXT NOT NULL CHECK (request_status IN ('pending', 'approved', 'declined', 'failed')),
  media_status TEXT NOT NULL CHECK (media_status IN ('unknown', 'pending', 'processing', 'partially_available', 'available')),
  radarr_id INTEGER,
  sonarr_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_by INTEGER,
  decided_at TEXT
);
`;

type Db = BetterSqlite3;

let db: Db | null = null;

function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
}

function initSchema(database: Db): void {
  database.exec(REQUESTS_SCHEMA);
}

export function openDatabase(dbPath: string): Db {
  try {
    ensureParentDirectory(dbPath);
    const database = new BetterSqlite3(dbPath);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    initSchema(database);
    db = database;
    return database;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to open database at ${dbPath}: ${detail}`);
  }
}

export function getDb(): Db {
  if (db === null) {
    throw new Error("Database not initialized; call openDatabase() first");
  }
  return db;
}

export function closeDatabase(): void {
  if (db !== null) {
    db.close();
    db = null;
  }
}
