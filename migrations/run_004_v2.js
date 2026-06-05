// run_004_v2.js — Rebuilds testimony_submissions with the full multi-format schema
// against the SAME database file the server uses (read from src/config/env.js).
//
// Run on Render Shell:
//   node migrations/run_004_v2.js
//
// Safe: the form hasn't been able to insert yet, so dropping & recreating the
// table loses nothing.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// Resolve the SAME db file path your server uses.
// migrations/ lives at /opt/render/project/src/migrations/
// src/config/env.js lives at /opt/render/project/src/src/config/env.js
// So path from this script: ../src/config/env
const env = require(path.join(__dirname, '..', 'src', 'config', 'env'));
const DB_PATH = env.databaseFile;
if (!DB_PATH) {
  console.error('env.databaseFile is not set. Aborting.');
  process.exit(1);
}
console.log('Using database:', DB_PATH);

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// Rebuild testimony_submissions with the full multi-format schema.
db.exec(`
  DROP TABLE IF EXISTS testimony_submissions;

  CREATE TABLE testimony_submissions (
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

  CREATE INDEX IF NOT EXISTS idx_testimony_submissions_status ON testimony_submissions(status);
  CREATE INDEX IF NOT EXISTS idx_testimony_submissions_format ON testimony_submissions(format);
  CREATE INDEX IF NOT EXISTS idx_testimony_submissions_created ON testimony_submissions(created_at DESC);
`);

const cols = db.prepare('PRAGMA table_info(testimony_submissions)').all().map(r => r.name);
console.log('testimony_submissions columns:', cols.join(', '));
console.log('Migration v2 complete.');
