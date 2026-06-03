-- YouTube integration schema additions for JIMK 2-QR / testimony system
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS youtube_oauth_tokens (
  id INTEGER PRIMARY KEY,
  channel_id TEXT,
  channel_title TEXT,
  access_token TEXT,
  refresh_token TEXT,
  scope TEXT,
  token_type TEXT,
  expiry_ms INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS youtube_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  testimonials_playlist_id TEXT,
  default_visibility TEXT DEFAULT 'unlisted',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO youtube_settings (id, default_visibility) VALUES (1, 'unlisted');

CREATE TABLE IF NOT EXISTS testimony_video_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER,
  submitted_name TEXT,
  submitted_email TEXT,
  permission_public INTEGER DEFAULT 0,  -- 1 if person gave permission to list on YouTube channel
  short_message TEXT,
  youtube_video_id TEXT,
  youtube_url TEXT,
  youtube_embed_url TEXT,
  privacy_status TEXT DEFAULT 'unlisted',
  added_to_testimonials_playlist INTEGER DEFAULT 0,
  review_status TEXT DEFAULT 'pending', -- pending / approved / rejected
  admin_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_tvu_status ON testimony_video_uploads(review_status, created_at DESC);
