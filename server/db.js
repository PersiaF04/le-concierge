/**
 * SQLite storage for the API, on Node's built-in `node:sqlite`.
 *
 * Each table keeps the columns the API filters on, plus a `doc` column with the
 * record in the apps' shape, so a row reads back exactly as it was served.
 * Migrations are numbered and tracked with `PRAGMA user_version`: add a new
 * entry to MIGRATIONS, never edit an old one.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  `
  CREATE TABLE residents (
    id TEXT PRIMARY KEY,
    flat TEXT,
    anonymous INTEGER NOT NULL DEFAULT 0,
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    doc TEXT NOT NULL
  );
  CREATE INDEX residents_flat ON residents(flat);

  -- face-api.js descriptors, only ever for residents who tapped "that was me".
  CREATE TABLE faces (
    resident_id TEXT PRIMARY KEY REFERENCES residents(id) ON DELETE CASCADE,
    descriptor TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE visits (
    id TEXT PRIMARY KEY,
    flat TEXT,
    status TEXT NOT NULL,
    at TEXT NOT NULL,
    execution_id TEXT,
    doc TEXT NOT NULL
  );
  CREATE INDEX visits_flat_status ON visits(flat, status);

  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id TEXT NOT NULL REFERENCES visits(id),
    decision TEXT NOT NULL,
    resident_id TEXT,
    note TEXT,
    signalled INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    flat TEXT,
    visit_id TEXT,
    resident_id TEXT,
    at TEXT NOT NULL,
    doc TEXT NOT NULL
  );
  CREATE INDEX events_flat_at ON events(flat, at);

  CREATE TABLE parcels (
    id TEXT PRIMARY KEY,
    flat TEXT,
    status TEXT NOT NULL,
    at TEXT NOT NULL,
    doc TEXT NOT NULL
  );

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resident_id TEXT,
    flat TEXT,
    at TEXT NOT NULL,
    doc TEXT NOT NULL
  );

  -- The wav Voxtral produced for a visit, served at speech.audioUrl.
  CREATE TABLE audio (
    visit_id TEXT PRIMARY KEY,
    wav BLOB NOT NULL
  );

  -- The last photograph the phone or the door sent, one per flat.
  CREATE TABLE snapshots (
    flat TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    doc TEXT NOT NULL
  );
  `,
];

/**
 * Open (or create) the database and bring its schema up to date.
 * @param {string} path a file path, or ':memory:'
 */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let step = version; step < MIGRATIONS.length; step += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[step]);
      db.exec(`PRAGMA user_version = ${step + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

/** The demo's one resident, so a fresh database has someone at flat 12. */
export function seedDemo(db) {
  const at = new Date().toISOString();
  const resident = { id: 'res_12_persia', name: 'Persia', flat: '12', anonymous: false };
  db.prepare(
    `INSERT OR IGNORE INTO residents (id, flat, anonymous, confirmed_at, created_at, doc)
     VALUES (?, ?, 0, NULL, ?, ?)`,
  ).run(resident.id, resident.flat, at, JSON.stringify(resident));
}
