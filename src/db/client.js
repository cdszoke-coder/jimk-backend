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

/**
 * Runs BEFORE schema.sql so schema.sql doesn't crash on stale/broken tables.
 * If testimony_submissions exists but lacks review_status (left over from a
 * previous migration), drop it so schema.sql can recreate it correctly.
 */
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
