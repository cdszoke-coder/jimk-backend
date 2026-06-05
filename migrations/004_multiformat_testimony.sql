-- 004_multiformat_testimony.sql
-- Adds multi-format submission support: video link/file, written, audio, photo+caption, send-later.
-- Safe to re-run: each ALTER guarded by PRAGMA check in the runner.

CREATE TABLE IF NOT EXISTS testimony_submissions (
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

-- Owner profile columns to support non-video formats on the wall
-- (owner_profiles already exists; add columns only if missing — handled in runner)
