// run_005.js — Restore the legacy testimony_submissions table and move the new
// multi-format intake into its own table 'testimony_intake'.
//
// Why: run_004_v2 unintentionally dropped & rebuilt testimony_submissions with a
// schema that didn't include review_status, breaking /api/admin/dashboard.
// This migration:
//   1. Drops the rebuilt testimony_submissions (the multi-format-only one I made)
//   2. Creates a NEW table 'testimony_intake' for multi-format submissions
//   3. Lets the server's existing schema.sql recreate the original
//      testimony_submissions on next boot (it uses CREATE TABLE IF NOT EXISTS).
//
// Run on Render Shell:
//   node migrations/run_005.js
//
// Then restart the backend service (or just commit anything to trigger redeploy).

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const env = require(path.join(__dirname, '..', 'src', 'config', 'env'));
const DB_PATH = env.databaseFile;
if (!DB_PATH) {
  console.error('env.databaseFile is not set. Aborting.');
  process.exit(1);
}
console.log('Using database:', DB_PATH);

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// 1. Drop the version I created so schema.sql can recreate the legacy original on next boot.
db.exec(`DROP TABLE IF EXISTS testimony_submissions;`);
console.log('Dropped testimony_submissions (the legacy schema will be restored on next server boot).');

// 2. Create the multi-format intake table separately.
db.exec(`
  CREATE TABLE IF NOT EXISTS testimony_intake (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name      TEXT NOT NULL,
    location          TEXT,
    discovery_source  TEXT CHECK (discovery_source IN ('shirt','sticker','qr','friend','other')),
    qr_code           TEXT,
    format            TEXT NOT NULL CHECK (format IN ('video','written','audio','photo','pending')),
    short_quote       TEXT,

    video_file_url    TEXT,
    video_link_url    TEXT,
    written_body      TEXT,
    audio_url         TEXT,
    photo_url         TEXT,
    photo_caption     TEXT,

    contact_email     TEXT,
    consent_lord      INTEGER NOT NULL DEFAULT 0,
    consent_publish   INTEGER NOT NULL DEFAULT 0,

    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','archived')),
    admin_notes       TEXT,
    approved_owner_id INTEGER,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_testimony_intake_status  ON testimony_intake(status);
  CREATE INDEX IF NOT EXISTS idx_testimony_intake_format  ON testimony_intake(format);
  CREATE INDEX IF NOT EXISTS idx_testimony_intake_created ON testimony_intake(created_at DESC);
`);

const cols = db.prepare('PRAGMA table_info(testimony_intake)').all().map(r => r.name);
console.log('testimony_intake columns:', cols.join(', '));
console.log('Migration 005 complete.');
