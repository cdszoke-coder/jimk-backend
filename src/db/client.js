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
  execFile(db, path.join(__dirname, 'schema.sql'));
  execFile(db, path.join(__dirname, 'seed.sql'));
  runLightMigrations(db);
  return db;
}

module.exports = {
  getDb() {
    return db || initDatabase();
  },
  initDatabase
};
