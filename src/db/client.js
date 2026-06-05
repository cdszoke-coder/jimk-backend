const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const env = require('../config/env');

let db;

function ensureDbDirectory() {
  const dir = path.dirname(env.databaseFile);
  fs.mkdirSync(dir, { recursive: true });
}

function execFile(database, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  database.exec(sql);
}

function columnExists(database, table, column) {
  try {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(row => row.name === column);
  } catch (error) {
    return false;
  }
}

function tableExists(database, table) {
  try {
    const row = database
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    return !!row;
  } catch (error) {
    return false;
  }
}

function earlyRepair(database) {
  try {
    if (tableExists(database, 'testimony_submissions')
        && !columnExists(database, 'testimony_submissions', 'review_status')) {
      database.exec('DROP TABLE testimony_submissions');
      console.log('[client] earlyRepair: dropped broken testimony_submissions; schema.sql will recreate it.');
    }
  } catch (error) {
    console.warn('[client] earlyRepair warning:', error.message);
  }
}

function ensureIntakeTable(database) {
  try {
    database.exec(`
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
  } catch (error) {
    console.warn('[client] ensureIntakeTable warning:', error.message);
  }
}

/**
 * Light migration: add multi-format columns to owner_profiles so non-video
 * testimonies (written / audio / photo) can be published to the wall.
 */
function migrateOwnerProfilesMultiformat(database) {
  try {
    const adds = [
      { col: 'format',        ddl: "ALTER TABLE owner_profiles ADD COLUMN format TEXT NOT NULL DEFAULT 'video'" },
      { col: 'written_body',  ddl: "ALTER TABLE owner_profiles ADD COLUMN written_body TEXT" },
      { col: 'audio_url',     ddl: "ALTER TABLE owner_profiles ADD COLUMN audio_url TEXT" },
      { col: 'photo_url',     ddl: "ALTER TABLE owner_profiles ADD COLUMN photo_url TEXT" },
      { col: 'photo_caption', ddl: "ALTER TABLE owner_profiles ADD COLUMN photo_caption TEXT" },
    ];
    for (const { col, ddl } of adds) {
      if (!columnExists(database, 'owner_profiles', col)) {
        database.exec(ddl);
        console.log('[client] owner_profiles +column:', col);
      }
    }
  } catch (error) {
    console.warn('[client] migrateOwnerProfilesMultiformat warning:', error.message);
  }
}

function runLightMigrations(database) {
  try {
    if (!columnExists(database, 'artist_profiles', 'portrait_image_url')) {
      database.exec('ALTER TABLE artist_profiles ADD COLUMN portrait_image_url TEXT');
    }
    if (!columnExists(database, 'artist_profiles', 'hero_source')) {
      database.exec("ALTER TABLE artist_profiles ADD COLUMN hero_source TEXT NOT NULL DEFAULT 'artwork'");
    }
  } catch (error) {
    console.warn('Light migration warning:', error.message);
  }
}

function initDatabase() {
  if (db) return db;
  ensureDbDirectory();
  db = new Database(env.databaseFile);
  db.pragma('foreign_keys = ON');
  earlyRepair(db);
  execFile(db, path.join(__dirname, 'schema.sql'));
  execFile(db, path.join(__dirname, 'seed.sql'));
  runLightMigrations(db);
  ensureIntakeTable(db);
  migrateOwnerProfilesMultiformat(db);
  const sql2Path = path.join(__dirname, 'schema_youtube.sql');
  if (fs.existsSync(sql2Path)) {
    db.exec(fs.readFileSync(sql2Path, 'utf8'));
  }
  return db;
}

module.exports = {
  getDb() {
    return db || initDatabase();
  },
  initDatabase
};
