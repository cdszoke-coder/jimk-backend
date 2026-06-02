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

function initDatabase() {
  if (db) return db;
  ensureDbDirectory();
  db = new Database(env.databaseFile);
  db.pragma('foreign_keys = ON');
  execFile(db, path.join(__dirname, 'schema.sql'));
  execFile(db, path.join(__dirname, 'seed.sql'));
  return db;
}

module.exports = {
  getDb() {
    return db || initDatabase();
  },
  initDatabase
};
