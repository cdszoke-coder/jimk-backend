PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS owner_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT UNIQUE,
  location TEXT,
  public_video_url TEXT NOT NULL,
  embed_video_url TEXT NOT NULL,
  short_quote TEXT,
  testimony_summary TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS testimony_item_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code TEXT NOT NULL UNIQUE,
  owner_profile_id INTEGER REFERENCES owner_profiles(id) ON DELETE SET NULL,
  destination_mode TEXT NOT NULL DEFAULT 'default_founder' CHECK (destination_mode IN ('default_founder','owner_profile')),
  first_scanned_at TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS testimony_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_name TEXT NOT NULL,
  submitted_email TEXT,
  location TEXT,
  public_video_url TEXT NOT NULL,
  embed_video_url TEXT NOT NULL,
  short_quote TEXT,
  testimony_summary TEXT,
  admin_notes TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved_new_owner','merged_to_existing','rejected')),
  suggested_owner_profile_id INTEGER REFERENCES owner_profiles(id) ON DELETE SET NULL,
  linked_owner_profile_id INTEGER REFERENCES owner_profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS testimony_submission_items (
  submission_id INTEGER NOT NULL REFERENCES testimony_submissions(id) ON DELETE CASCADE,
  item_code_id INTEGER NOT NULL REFERENCES testimony_item_codes(id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, item_code_id)
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_item_codes_owner_profile_id ON testimony_item_codes(owner_profile_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON testimony_submissions(review_status);
CREATE INDEX IF NOT EXISTS idx_submissions_email ON testimony_submissions(submitted_email);
CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON testimony_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_status_created_at ON testimony_submissions(review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_profiles_email ON owner_profiles(email);
CREATE INDEX IF NOT EXISTS idx_owner_profiles_status_updated_at ON owner_profiles(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_owner_profiles_slug ON owner_profiles(slug);

CREATE TABLE IF NOT EXISTS artist_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  location TEXT,
  medium TEXT,
  joined_label TEXT,
  short_quote TEXT,
  bio TEXT,
  testimony_summary TEXT,
  public_video_url TEXT,
  embed_video_url TEXT,
  hero_image_url TEXT,
  artwork_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_artist_profiles_status ON artist_profiles(status);
CREATE INDEX IF NOT EXISTS idx_artist_profiles_slug ON artist_profiles(slug);
