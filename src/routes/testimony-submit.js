// routes/testimony-submit.js
// Public multi-format testimony submission endpoint.
// Files are written into the same /uploads dir the rest of the backend uses,
// served back via /uploads/... (absolute URL).

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { getDb } = require('../db/client');

const router = express.Router();

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const baseDir = req.app.get('uploadsDir') ||
      process.env.UPLOADS_DIR ||
      '/opt/render/project/src/data/uploads';
    let sub = 'testimony-photo';
    if (file.fieldname === 'video_file') sub = 'testimony-video';
    else if (file.fieldname === 'audio_file') sub = 'testimony-audio';
    else if (file.fieldname === 'photo_file') sub = 'testimony-photo';
    const dir = path.join(baseDir, sub);
    ensureDir(dir);
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '';
    const safe = `${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB cap
}).fields([
  { name: 'video_file', maxCount: 1 },
  { name: 'audio_file', maxCount: 1 },
  { name: 'photo_file', maxCount: 1 },
]);

function publicUrlFor(req, absPath) {
  if (!absPath) return null;
  const baseDir = req.app.get('uploadsDir') ||
    process.env.UPLOADS_DIR ||
    '/opt/render/project/src/data/uploads';
  const rel = path.relative(baseDir, absPath).replace(/\\/g, '/');
  const base = (process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/uploads/${rel}`;
}

function clean(s, max = 5000) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

router.post('/', upload, (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(500).json({ error: 'database not ready' });

    const b = req.body || {};
    const format = clean(b.format, 20);
    const validFormats = ['video','written','audio','photo','pending'];
    if (!validFormats.includes(format)) {
      return res.status(400).json({ error: 'Invalid format' });
    }

    const display_name = clean(b.display_name, 120);
    if (!display_name) return res.status(400).json({ error: 'Name is required' });

    const discovery_source = ['shirt','sticker','qr','friend','other'].includes(b.discovery_source)
      ? b.discovery_source : null;
    if (!discovery_source) return res.status(400).json({ error: 'Tell us how you found us' });

    const consent_lord    = b.consent_lord === 'true' || b.consent_lord === '1' || b.consent_lord === 'on' ? 1 : 0;
    const consent_publish = b.consent_publish === 'true' || b.consent_publish === '1' || b.consent_publish === 'on' ? 1 : 0;
    if (!consent_lord || !consent_publish) {
      return res.status(400).json({ error: 'Both consent boxes are required' });
    }

    const location    = clean(b.location, 120);
    const qr_code     = clean((b.qr_code || '').toUpperCase(), 60);
    const short_quote = clean(b.short_quote, 200);

    const files = req.files || {};
    const video_file_url = files.video_file ? publicUrlFor(req, files.video_file[0].path) : null;
    const audio_url      = files.audio_file ? publicUrlFor(req, files.audio_file[0].path) : null;
    const photo_url      = files.photo_file ? publicUrlFor(req, files.photo_file[0].path) : null;

    const video_link_url = clean(b.video_link_url, 600);
    const written_body   = clean(b.written_body, 3000);
    const photo_caption  = clean(b.photo_caption, 1500);
    const contact_email  = clean(b.contact_email, 200);

    if (format === 'video' && !video_file_url && !video_link_url) {
      return res.status(400).json({ error: 'Upload a video file or paste a video link' });
    }
    if (format === 'written' && (!written_body || written_body.length < 30)) {
      return res.status(400).json({ error: 'Written testimony must be at least 30 characters' });
    }
    if (format === 'audio' && !audio_url) {
      return res.status(400).json({ error: 'Upload an audio file' });
    }
    if (format === 'photo' && (!photo_url || !photo_caption)) {
      return res.status(400).json({ error: 'Upload a photo and add a caption' });
    }
    if (format === 'pending' && !contact_email) {
      return res.status(400).json({ error: 'Email is required so we can follow up' });
    }

    const stmt = db.prepare(`
      INSERT INTO testimony_submissions (
        display_name, location, discovery_source, qr_code, format, short_quote,
        video_file_url, video_link_url, written_body, audio_url, photo_url, photo_caption,
        contact_email, consent_lord, consent_publish
      ) VALUES (
        @display_name, @location, @discovery_source, @qr_code, @format, @short_quote,
        @video_file_url, @video_link_url, @written_body, @audio_url, @photo_url, @photo_caption,
        @contact_email, @consent_lord, @consent_publish
      )
    `);
    const result = stmt.run({
      display_name, location, discovery_source, qr_code, format, short_quote,
      video_file_url, video_link_url, written_body, audio_url, photo_url, photo_caption,
      contact_email, consent_lord, consent_publish,
    });

    return res.json({ ok: true, id: result.lastInsertRowid, status: 'pending' });
  } catch (e) {
    console.error('testimony submit error:', e);
    return res.status(500).json({ error: 'Submission failed' });
  }
});

module.exports = router;
