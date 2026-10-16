'use strict';
// src/routes/artworkPieces.js
// -----------------------------------------------------------------------------
// Per-artwork DESCRIPTIONS + per-item QR CODES for the artist pages.
//
//   An artist uploads artwork (existing flow, admin-artists.js).
//   For each uploaded artwork the admin can now:
//     • add a title, a description ("About this piece"), an artist quote,
//       medium, year, and an "original for sale" flag           -> artwork_pieces
//     • create one QR code per item the art is printed on
//       (shirt, sticker, makeup bag, hoodie, ...)                 -> artwork_print_codes
//
//   Each QR code points to:
//     https://www.jesusismykingmovement.com/artist.html?art=JIMK-ART-0001
//   and artist.html looks the code up here to show that exact piece at the top.
//
// ROUTES (all mounted under /api)
//   Public
//     GET    /api/public/art/:code                 -> piece + artist + item for a QR code
//     GET    /api/public/artists/:slug/pieces      -> titles/descriptions for an artist's gallery
//   Admin  (header x-admin-key, same key the admin page already stores)
//     GET    /api/admin/art-pieces?artist_id=1     -> all pieces + their codes for one artist
//     PUT    /api/admin/art-pieces                 -> create/update details for one artwork
//     POST   /api/admin/art-pieces/:pieceId/codes  -> create a new QR code for an item
//     PATCH  /api/admin/art-codes/:code            -> change item type / shop link
//     DELETE /api/admin/art-codes/:code            -> retire a code (page shows the artist instead)
//
// WIRE-UP (src/server.js) — right after the /healthz line:
//   const artworkPiecesRoute = safeRequireRouter('./routes/artworkPieces');
//   if (artworkPiecesRoute) app.use('/api', artworkPiecesRoute);
// -----------------------------------------------------------------------------

const express = require('express');
const { getDb } = require('../db/client');

let env = {};
try { env = require('../config/env') || {}; } catch (e) { env = {}; }

const router = express.Router();
const CODE_PREFIX = 'JIMK-ART-';

// ---------------------------------------------------------------------------
// The artists table name is DETECTED, not assumed. Set ARTISTS_TABLE (env var
// on Render) to force a specific name; otherwise we find the table that has
// both an `id` and a `slug` column plus the most artist-like columns.
// ---------------------------------------------------------------------------
let _artistTable;
let _artistCols;

function tableColumns(d, name) {
  try { return d.prepare('PRAGMA table_info(' + name + ')').all().map(function (c) { return c.name; }); }
  catch (e) { return []; }
}

function resolveArtistTable() {
  if (_artistTable !== undefined) return _artistTable;
  const forced = process.env.ARTISTS_TABLE || env.artistsTable || env.ARTISTS_TABLE;
  if (forced) { _artistTable = forced; return forced; }

  const d = getDb();
  let names = [];
  try { names = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(function (r) { return r.name; }); }
  catch (e) { names = []; }

  let best = null, bestScore = 0;
  names.forEach(function (n) {
    const cols = tableColumns(d, n);
    if (cols.indexOf('id') === -1 || cols.indexOf('slug') === -1) return;
    let score = 0;
    if (cols.indexOf('display_name') !== -1) score += 100;
    if (cols.indexOf('portrait_image_url') !== -1) score += 20;
    if (cols.indexOf('artwork_json') !== -1) score += 20;
    if (cols.indexOf('bio') !== -1) score += 10;
    if (cols.indexOf('hero_image_url') !== -1) score += 10;
    if (/artist/i.test(n)) score += 50;
    if (/code|artwork|piece|testimony/i.test(n)) score -= 200;
    if (score > bestScore) { bestScore = score; best = n; }
  });
  _artistTable = best;
  return best;
}

function resolveArtistCols() {
  if (_artistCols) return _artistCols;
  const t = resolveArtistTable();
  const cols = t ? tableColumns(getDb(), t) : [];
  _artistCols = {
    id: cols.indexOf('id') !== -1,
    slug: cols.indexOf('slug') !== -1,
    display_name: cols.indexOf('display_name') !== -1,
    status: cols.indexOf('status') !== -1
  };
  return _artistCols;
}

function fetchArtist(whereCol, value) {
  const t = resolveArtistTable();
  const cols = resolveArtistCols();
  if (!t || !cols[whereCol]) return null;
  const sel = ['id', 'slug'].filter(function (c) { return cols[c]; });
  if (cols.display_name) sel.push('display_name');
  if (cols.status) sel.push('status');
  if (!sel.length) return null;
  let row;
  try { row = getDb().prepare('SELECT ' + sel.join(', ') + ' FROM ' + t + ' WHERE ' + whereCol + ' = ? LIMIT 1').get(value); }
  catch (e) { console.error('[artworkPieces] artist lookup failed:', e.message); return null; }
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name || '',
    status: row.status == null ? 'active' : row.status   // no status column / NULL = visible
  };
}

/* ------------------------------------------------------------------ schema */
let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS artwork_pieces (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        artist_id         INTEGER NOT NULL,
        artwork_url       TEXT    NOT NULL,
        title             TEXT    DEFAULT '',
        description       TEXT    DEFAULT '',
        show_description  INTEGER DEFAULT 1,
        quote             TEXT    DEFAULT '',
        medium            TEXT    DEFAULT '',
        year              TEXT    DEFAULT '',
        original_for_sale INTEGER DEFAULT 0,
        inquiry_url       TEXT    DEFAULT '',
        created_at        TEXT    DEFAULT CURRENT_TIMESTAMP,
        updated_at        TEXT    DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (artist_id, artwork_url)
      );
      CREATE TABLE IF NOT EXISTS artwork_print_codes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT    NOT NULL UNIQUE,
        piece_id    INTEGER NOT NULL,
        item_type   TEXT    NOT NULL DEFAULT 'item',
        item_label  TEXT    DEFAULT '',
        shop_url    TEXT    DEFAULT '',
        status      TEXT    DEFAULT 'active',
        scan_count  INTEGER DEFAULT 0,
        last_scan_at TEXT,
        created_at  TEXT    DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_art_codes_piece ON artwork_print_codes(piece_id);
    `);
    ready = true;
  }
  return d;
}

/* -------------------------------------------------------------- helpers */
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 4000);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? 1 : 0;

function normalizeCode(raw) {
  let s = String(raw || '').trim().toUpperCase().replace(/_/g, '-');
  if (/^\d{1,6}$/.test(s)) s = CODE_PREFIX + s.padStart(4, '0');
  if (/^ART-?\d+$/.test(s)) s = CODE_PREFIX + s.replace(/^ART-?/, '').padStart(4, '0');
  const m = s.match(/^JIMK-?ART-?(\d{1,6})$/);
  return m ? CODE_PREFIX + m[1].padStart(4, '0') : null;
}

function adminKeys() {
  return [
    env.adminKey, env.adminApiKey, env.admin_key, env.ADMIN_KEY,
    process.env.ADMIN_KEY, process.env.ADMIN_API_KEY, process.env.JIMK_ADMIN_KEY
  ].filter(k => typeof k === 'string' && k.length > 0);
}
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || '';
  const keys = adminKeys();
  if (!key || !keys.length || !keys.includes(key)) {
    return res.status(401).json({ error: 'Unauthorized admin request' });
  }
  next();
}

function artistById(id) { return fetchArtist('id', id); }
function artistBySlug(slug) { return fetchArtist('slug', slug); }

function pieceOut(p) {
  if (!p) return null;
  return {
    id: p.id,
    artist_id: p.artist_id,
    artwork_url: p.artwork_url,
    title: p.title || '',
    description: p.description || '',
    show_description: !!p.show_description,
    quote: p.quote || '',
    medium: p.medium || '',
    year: p.year || '',
    original_for_sale: !!p.original_for_sale,
    inquiry_url: p.inquiry_url || '',
    updated_at: p.updated_at
  };
}
function codeOut(c) {
  return {
    code: c.code,
    piece_id: c.piece_id,
    item_type: c.item_type,
    item_label: c.item_label || '',
    shop_url: c.shop_url || '',
    status: c.status,
    scan_count: c.scan_count || 0,
    last_scan_at: c.last_scan_at || null,
    created_at: c.created_at
  };
}

function nextCode(d) {
  const row = d.prepare(`
    SELECT MAX(CAST(SUBSTR(code, ${CODE_PREFIX.length + 1}) AS INTEGER)) AS n
    FROM artwork_print_codes WHERE code LIKE '${CODE_PREFIX}%'
  `).get();
  const n = (row && row.n ? row.n : 0) + 1;
  return CODE_PREFIX + String(n).padStart(4, '0');
}

/* ================================================================ PUBLIC */

// QR scan lookup
router.get('/public/art/:code', (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return res.status(404).json({ error: 'not found' });
  try {
    const d = db();
    const c = d.prepare(`SELECT * FROM artwork_print_codes WHERE code = ?`).get(code);
    if (!c || c.status !== 'active') return res.status(404).json({ error: 'not found' });
    const p = d.prepare(`SELECT * FROM artwork_pieces WHERE id = ?`).get(c.piece_id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const a = artistById(p.artist_id);
    if (!a || a.status === 'archived') return res.status(404).json({ error: 'not found' });

    try {
      d.prepare(`UPDATE artwork_print_codes SET scan_count = scan_count + 1, last_scan_at = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
    } catch (e) { /* scan counting is best-effort */ }

    const piece = pieceOut(p);
    if (!piece.show_description) piece.description = '';
    res.set('Cache-Control', 'no-store');
    res.json({
      code: c.code,
      item_type: c.item_type,
      item_label: c.item_label || c.item_type,
      shop_url: c.shop_url || '',
      artist: { id: a.id, slug: a.slug, display_name: a.display_name },
      piece
    });
  } catch (err) {
    console.error('[artworkPieces] public lookup failed', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

// Titles / descriptions for the gallery on an artist page
router.get('/public/artists/:slug/pieces', (req, res) => {
  try {
    const a = artistBySlug(str(req.params.slug, 200));
    if (!a || a.status === 'archived') return res.json({ pieces: [] });
    const rows = db().prepare(`SELECT * FROM artwork_pieces WHERE artist_id = ?`).all(a.id);
    res.json({
      pieces: rows.map(pieceOut).map(p => {
        if (!p.show_description) p.description = '';
        return p;
      })
    });
  } catch (err) {
    console.error('[artworkPieces] public pieces failed', err.message);
    res.json({ pieces: [] });
  }
});

/* ================================================================= ADMIN */

// Diagnostic: shows which table was detected. Safe (admin key required).
router.get('/admin/art-debug', requireAdmin, (req, res) => {
  const d = getDb();
  let tables = [];
  try { tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(function (r) { return r.name; }); }
  catch (e) { /* ignore */ }
  const detected = resolveArtistTable();
  res.json({
    detected_artists_table: detected || null,
    columns: detected ? tableColumns(d, detected) : [],
    all_tables: tables,
    forced_by_env: !!(process.env.ARTISTS_TABLE || env.artistsTable || env.ARTISTS_TABLE)
  });
});

router.get('/admin/art-pieces', requireAdmin, (req, res) => {
  const artistId = parseInt(req.query.artist_id, 10);
  if (!artistId) return res.status(400).json({ error: 'artist_id is required' });
  try {
    const d = db();
    const pieces = d.prepare(`SELECT * FROM artwork_pieces WHERE artist_id = ? ORDER BY id`).all(artistId);
    const ids = pieces.map(p => p.id);
    const codes = ids.length
      ? d.prepare(`SELECT * FROM artwork_print_codes WHERE piece_id IN (${ids.map(() => '?').join(',')}) AND status = 'active' ORDER BY id`).all(...ids)
      : [];
    res.json({
      pieces: pieces.map(p => Object.assign(pieceOut(p), {
        codes: codes.filter(c => c.piece_id === p.id).map(codeOut)
      }))
    });
  } catch (err) {
    console.error('[artworkPieces] admin list failed', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create or update the details for one uploaded artwork
router.put('/admin/art-pieces', requireAdmin, (req, res) => {
  const b = req.body || {};
  const artistId = parseInt(b.artist_id, 10);
  const artworkUrl = str(b.artwork_url, 1000);
  if (!artistId || !artworkUrl) return res.status(400).json({ error: 'artist_id and artwork_url are required' });
  try {
    if (!artistById(artistId)) return res.status(404).json({ error: 'artist not found' });
    const d = db();
    d.prepare(`
      INSERT INTO artwork_pieces
        (artist_id, artwork_url, title, description, show_description, quote, medium, year, original_for_sale, inquiry_url, updated_at)
      VALUES (@artist_id, @artwork_url, @title, @description, @show_description, @quote, @medium, @year, @original_for_sale, @inquiry_url, CURRENT_TIMESTAMP)
      ON CONFLICT(artist_id, artwork_url) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        show_description = excluded.show_description,
        quote = excluded.quote,
        medium = excluded.medium,
        year = excluded.year,
        original_for_sale = excluded.original_for_sale,
        inquiry_url = excluded.inquiry_url,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      artist_id: artistId,
      artwork_url: artworkUrl,
      title: str(b.title, 200),
      description: str(b.description, 4000),
      show_description: b.show_description === undefined ? 1 : bool(b.show_description),
      quote: str(b.quote, 600),
      medium: str(b.medium, 120),
      year: str(b.year, 20),
      original_for_sale: bool(b.original_for_sale),
      inquiry_url: str(b.inquiry_url, 500)
    });
    const p = d.prepare(`SELECT * FROM artwork_pieces WHERE artist_id = ? AND artwork_url = ?`).get(artistId, artworkUrl);
    res.json({ piece: pieceOut(p) });
  } catch (err) {
    console.error('[artworkPieces] save failed', err.message);
    res.status(500).json({ error: err.message });
  }
});

// New QR code for one item (shirt / sticker / makeup bag / ...)
router.post('/admin/art-pieces/:pieceId/codes', requireAdmin, (req, res) => {
  const pieceId = parseInt(req.params.pieceId, 10);
  const b = req.body || {};
  const itemType = str(b.item_type, 60).toLowerCase() || 'item';
  try {
    const d = db();
    const p = d.prepare(`SELECT id FROM artwork_pieces WHERE id = ?`).get(pieceId);
    if (!p) return res.status(404).json({ error: 'piece not found — save the artwork details first' });
    const create = d.transaction(() => {
      const code = nextCode(d);
      d.prepare(`INSERT INTO artwork_print_codes (code, piece_id, item_type, item_label, shop_url) VALUES (?, ?, ?, ?, ?)`)
        .run(code, pieceId, itemType, str(b.item_label, 80), str(b.shop_url, 500));
      return d.prepare(`SELECT * FROM artwork_print_codes WHERE code = ?`).get(code);
    });
    res.json({ code: codeOut(create()) });
  } catch (err) {
    console.error('[artworkPieces] create code failed', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/art-codes/:code', requireAdmin, (req, res) => {
  const code = normalizeCode(req.params.code);
  const b = req.body || {};
  if (!code) return res.status(400).json({ error: 'bad code' });
  try {
    const d = db();
    const c = d.prepare(`SELECT * FROM artwork_print_codes WHERE code = ?`).get(code);
    if (!c) return res.status(404).json({ error: 'code not found' });
    d.prepare(`UPDATE artwork_print_codes SET item_type = ?, item_label = ?, shop_url = ? WHERE code = ?`).run(
      b.item_type !== undefined ? (str(b.item_type, 60).toLowerCase() || 'item') : c.item_type,
      b.item_label !== undefined ? str(b.item_label, 80) : c.item_label,
      b.shop_url !== undefined ? str(b.shop_url, 500) : c.shop_url,
      code
    );
    res.json({ code: codeOut(d.prepare(`SELECT * FROM artwork_print_codes WHERE code = ?`).get(code)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retire (soft-delete) — the code number is never reused, so old prints never point at a new item
router.delete('/admin/art-codes/:code', requireAdmin, (req, res) => {
  const code = normalizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'bad code' });
  try {
    db().prepare(`UPDATE artwork_print_codes SET status = 'retired' WHERE code = ?`).run(code);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
