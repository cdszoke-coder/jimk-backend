'use strict';

/**
 * Welcome / Call-to-Action video endpoints.
 *
 * Public:
 *   GET  /api/public/welcome
 *     Returns { title, short_cta, public_video_url, embed_video_url }.
 *     Used by the movement page, story (QR) page, and homepage placeholder.
 *     This replaces the old "founder default" concept on the visitor side.
 *
 * Admin (requires x-admin-key):
 *   PATCH /api/admin/settings/welcome
 *     Body: { title, short_cta, public_video_url, embed_video_url }
 *     Updates the Welcome Video record. Internally still stored in the same
 *     row as the old founder default so existing QR-resolution code keeps
 *     working without a schema migration.
 *
 * Storage model:
 *   We reuse the existing site_settings rows that previously stored the
 *   "founder" data. Keys used:
 *     founder.display_name      -> title
 *     founder.testimony_summary -> short_cta
 *     founder.public_video_url  -> public_video_url
 *     founder.embed_video_url   -> embed_video_url
 *
 *   That way, unlinked QR codes that resolve through the existing founder
 *   path still show the welcome video automatically.
 */

const express = require('express');
const { getDb } = require('../db/client');

const router = express.Router();

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY || 'change-this-admin-key';
  if (!key || key !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return row && row.value != null ? row.value : '';
}

function setSetting(db, key, value) {
  const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
  if (existing) {
    db.prepare('UPDATE site_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?').run(value, key);
  } else {
    db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run(key, value);
  }
}

function toEmbed(url) {
  if (!url) return '';
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (m) return 'https://www.youtube.com/embed/' + m[1];
  return url;
}

const DEFAULTS = {
  title: 'Welcome to the Movement',
  short_cta: 'This wall is filled with people who put Jesus first and confess Him as Lord. Share your testimony and join a community of neighbors confessing the same.',
  public_video_url: '',
  embed_video_url: ''
};

router.get('/public/welcome', (req, res) => {
  const db = getDb();
  const title       = getSetting(db, 'founder.display_name')      || DEFAULTS.title;
  const short_cta   = getSetting(db, 'founder.testimony_summary') || DEFAULTS.short_cta;
  const pub         = getSetting(db, 'founder.public_video_url')  || '';
  const emb         = getSetting(db, 'founder.embed_video_url')   || toEmbed(pub);
  res.json({
    title: title,
    short_cta: short_cta,
    public_video_url: pub,
    embed_video_url: emb
  });
});

router.patch('/admin/settings/welcome', adminAuth, (req, res) => {
  const b = req.body || {};
  const db = getDb();
  if (b.title != null)             setSetting(db, 'founder.display_name',      String(b.title).slice(0, 200));
  if (b.short_cta != null)         setSetting(db, 'founder.testimony_summary', String(b.short_cta).slice(0, 2000));
  if (b.public_video_url != null)  setSetting(db, 'founder.public_video_url',  String(b.public_video_url).slice(0, 500));
  if (b.embed_video_url != null || b.public_video_url != null) {
    const pub = b.public_video_url != null ? String(b.public_video_url) : getSetting(db, 'founder.public_video_url');
    const emb = b.embed_video_url   != null ? String(b.embed_video_url)   : toEmbed(pub);
    setSetting(db, 'founder.embed_video_url', emb);
  }
  res.json({ ok: true });
});

module.exports = router;
