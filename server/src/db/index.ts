import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const REQUESTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  title TEXT NOT NULL,
  seasons TEXT,
  requested_by_seerr_id INTEGER NOT NULL,
  requested_by_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'processing', 'available', 'declined')),
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
