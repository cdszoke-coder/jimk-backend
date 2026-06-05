// run_004.js — applies 004_multiformat_testimony migration safely (idempotent)
// Usage on Render: node backend/migrations/run_004.js
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.JIMK_DATA_DIR || '/opt/render/project/src/data';
const DB_PATH = process.env.JIMK_DB_PATH || path.join(DATA_DIR, 'jimk.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const sql = fs.readFileSync(path.join(__dirname, '004_multiformat_testimony.sql'), 'utf8');
db.exec(sql);

function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === column);
}

// Add owner_profiles columns to support non-video formats on the wall
const ownerAdds = [
  { col: 'format',         ddl: `ALTER TABLE owner_profiles ADD COLUMN format TEXT NOT NULL DEFAULT 'video'` },
  { col: 'written_body',   ddl: `ALTER TABLE owner_profiles ADD COLUMN written_body TEXT` },
  { col: 'audio_url',      ddl: `ALTER TABLE owner_profiles ADD COLUMN audio_url TEXT` },
  { col: 'photo_url',      ddl: `ALTER TABLE owner_profiles ADD COLUMN photo_url TEXT` },
  { col: 'photo_caption',  ddl: `ALTER TABLE owner_profiles ADD COLUMN photo_caption TEXT` },
  { col: 'short_quote',    ddl: `ALTER TABLE owner_profiles ADD COLUMN short_quote TEXT` },
];

try {
  for (const { col, ddl } of ownerAdds) {
    if (!columnExists('owner_profiles', col)) {
      db.exec(ddl);
      console.log('Added owner_profiles.' + col);
    }
  }
} catch (e) {
  console.warn('owner_profiles column add skipped:', e.message);
}

console.log('Migration 004 complete at', DB_PATH);
