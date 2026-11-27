import { migrateMemories } from "./memory.ts";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  request_enc    TEXT NOT NULL,
  transcript_enc TEXT,
  result_enc     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  messages_enc TEXT NOT NULL,
  turns        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text_enc   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS protected_values (
  token       TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  value_enc   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  seq       INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,
  task_id   TEXT,
  type      TEXT NOT NULL,
  data_enc  TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_task ON audit(task_id);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`;

/**
 * Local SQLite database. Sensitive columns are encrypted by the caller (AES-256-GCM);
 * the file itself is 0600 inside a 0700 directory, and FileVault covers the disk.
 */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrateMemories(db);
  fs.chmodSync(file, 0o600);
  return db;
}

/** Run `fn` inside an IMMEDIATE transaction (serializes writers across processes). */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
