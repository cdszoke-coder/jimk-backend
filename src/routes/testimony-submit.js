// routes/testimony-submit.js
// Public multi-format testimony submission endpoint.
//
// Routes mounted here (under /api/public):
//   POST /testimony                       — multipart form for written/audio/photo + small video link submissions
//   POST /testimony/youtube-init          — direct-to-YouTube: returns a one-time Google upload URL + intake row id
//   POST /testimony/youtube-finalize      — direct-to-YouTube: marks the intake row pending after the browser PUTs the bytes to Google
//
// Direct-to-YouTube flow keeps the video bytes off the server entirely.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { getDb } = require('../db/client');

let yt = null;
try { yt = require('../services/youtubeService'); }
catch (err) { console.warn('[testimony-submit] youtubeService not loaded:', err.message); }

let mail = null;
try { mail = require('../services/mailService'); }
catch (err) { console.warn('[testimony-submit] mailService not loaded:', err.message); }

function fireMailFor(intakeRow) {
  if (!mail || !intakeRow) return;
  // Best-effort: never block the HTTP response on email send
  setImmediate(() => {
    try { mail.sendAdminNewSubmission(intakeRow).catch(e => console.warn('[testimony-submit] admin mail failed:', e.message)); } catch (_) {}
    try { mail.sendThankYou(intakeRow).catch(e => console.warn('[testimony-submit] thank-you mail failed:', e.message)); } catch (_) {}
  });
}

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
  limits: { fileSize: 200 * 1024 * 1024 },
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

function pickDiscoverySource(v) {
  return ['shirt','sticker','qr','friend','other'].includes(v) ? v : null;
}

function boolish(v) {
  return v === 'true' || v === '1' || v === 'on' || v === true ? 1 : 0;
}

// ---------- Existing multipart endpoint (written / audio / photo / video-link) ----------
router.post('/', upload, (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(500).json({ error: 'database not ready' });

    const b = req.body || {};
    const format = clean(b.format, 20);
    const validFormats = ['video','written','audio','photo','pending'];
    if (!validFormats.includes(format)) return res.status(400).json({ error: 'Invalid format' });

    const display_name = clean(b.display_name, 120);
    if (!display_name) return res.status(400).json({ error: 'Name is required' });

    const discovery_source = pickDiscoverySource(b.discovery_source);
    if (!discovery_source) return res.status(400).json({ error: 'Tell us how you found us' });

    const consent_lord    = boolish(b.consent_lord);
    const consent_publish = boolish(b.consent_publish);
    if (!consent_lord || !consent_publish) return res.status(400).json({ error: 'Both consent boxes are required' });

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

    // Six opt-in social links. Stored as NULL when blank — never rendered when empty.
    const social_instagram = clean(b.social_instagram, 300);
    const social_tiktok    = clean(b.social_tiktok, 300);
    const social_youtube   = clean(b.social_youtube, 300);
    const social_facebook  = clean(b.social_facebook, 300);
    const social_spotify   = clean(b.social_spotify, 300);
    const social_website   = clean(b.social_website, 300);

    if (format === 'video' && !video_file_url && !video_link_url) {
      return res.status(400).json({ error: 'Upload a video file or paste a video link' });
    }
    if (format === 'written' && (!written_body || written_body.length < 30)) {
      return res.status(400).json({ error: 'Written testimony must be at least 30 characters' });
    }
    if (format === 'audio' && !audio_url) return res.status(400).json({ error: 'Upload an audio file' });
    if (format === 'photo' && (!photo_url || !photo_caption)) return res.status(400).json({ error: 'Upload a photo and add a caption' });
    if (format === 'pending' && !contact_email) return res.status(400).json({ error: 'Email is required so we can follow up' });

    const stmt = db.prepare(`
      INSERT INTO testimony_intake (
        display_name, location, discovery_source, qr_code, format, short_quote,
        video_file_url, video_link_url, written_body, audio_url, photo_url, photo_caption,
        contact_email, consent_lord, consent_publish,
        social_instagram, social_tiktok, social_youtube,
        social_facebook, social_spotify, social_website
      ) VALUES (
        @display_name, @location, @discovery_source, @qr_code, @format, @short_quote,
        @video_file_url, @video_link_url, @written_body, @audio_url, @photo_url, @photo_caption,
        @contact_email, @consent_lord, @consent_publish,
        @social_instagram, @social_tiktok, @social_youtube,
        @social_facebook, @social_spotify, @social_website
      )
    `);
    const result = stmt.run({
      display_name, location, discovery_source, qr_code, format, short_quote,
      video_file_url, video_link_url, written_body, audio_url, photo_url, photo_caption,
      contact_email, consent_lord, consent_publish,
      social_instagram, social_tiktok, social_youtube,
      social_facebook, social_spotify, social_website,
    });

    const intakeId = result.lastInsertRowid;

    // Fire-and-forget emails (admin notification + submitter thank-you)
    fireMailFor({
      id: intakeId, display_name, location, discovery_source, qr_code, format,
      short_quote, video_file_url, video_link_url, written_body, audio_url,
      photo_url, photo_caption, contact_email,
      social_instagram, social_tiktok, social_youtube,
      social_facebook, social_spotify, social_website
    });

    return res.json({ ok: true, id: intakeId, status: 'pending' });
  } catch (e) {
    console.error('testimony submit error:', e);
    return res.status(500).json({ error: 'Submission failed' });
  }
});

// ---------- Direct-to-YouTube: STEP 1, init ----------
// Browser sends form metadata + file size; server asks Google for a one-time upload URL,
// creates a placeholder testimony_intake row, and returns { upload_url, intake_id }.
router.post('/youtube-init', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(500).json({ error: 'database not ready' });
    if (!yt) return res.status(503).json({ error: 'YouTube service unavailable on server' });
    if (typeof yt.isConnected === 'function' && !yt.isConnected()) {
      return res.status(503).json({ error: 'Video uploads are temporarily unavailable. Please try a different format or try again later.' });
    }

    const b = req.body || {};
    const display_name = clean(b.display_name, 120);
    if (!display_name) return res.status(400).json({ error: 'Name is required' });

    const discovery_source = pickDiscoverySource(b.discovery_source);
    if (!discovery_source) return res.status(400).json({ error: 'Tell us how you found us' });

    const consent_lord    = boolish(b.consent_lord);
    const consent_publish = boolish(b.consent_publish);
    if (!consent_lord || !consent_publish) return res.status(400).json({ error: 'Both consent boxes are required' });

    const wants_feature = boolish(b.wants_feature);

    const location    = clean(b.location, 120);
    const qr_code     = clean((b.qr_code || '').toUpperCase(), 60);
    const short_quote = clean(b.short_quote, 200);
    const contact_email = clean(b.contact_email, 200);

    // Six opt-in social links (stored as NULL when blank, never rendered when empty).
    const social_instagram = clean(b.social_instagram, 300);
    const social_tiktok    = clean(b.social_tiktok, 300);
    const social_youtube   = clean(b.social_youtube, 300);
    const social_facebook  = clean(b.social_facebook, 300);
    const social_spotify   = clean(b.social_spotify, 300);
    const social_website   = clean(b.social_website, 300);

    const fileSize = Number(b.file_size);
    if (!Number.isFinite(fileSize) || fileSize <= 0) return res.status(400).json({ error: 'file_size is required' });
    if (fileSize > 5 * 1024 * 1024 * 1024) return res.status(413).json({ error: 'Video is too large (max 5 GB).' });
    const contentType = clean(b.content_type, 80) || 'video/*';

    // Always upload as Private. If submitter consents to being featured, admin can
    // later flip it to Unlisted/Public from the moderation modal (Layer 2c controls).
    const privacyStatus = 'private';

    const title = `Shared Testimony: ${display_name}${location ? ' — ' + location : ''}`;
    const description = [
      short_quote ? `"${short_quote}"` : '',
      '',
      'Shared through JESUS IS MY KING MOVEMENT.',
      'Post your testimony: https://www.jesusismykingmovement.com/testimony.html'
    ].filter(Boolean).join('\n');

    const session = await yt.createResumableUploadSession({
      title, description, privacyStatus,
      fileSize, contentType
    });
    if (!session || !session.uploadUrl) return res.status(500).json({ error: 'Could not start YouTube upload session' });

    // Create the intake row up front (status='pending' to satisfy the CHECK constraint).
    // We tag admin_notes so moderators can see the upload is in progress.
    const stmt = db.prepare(`
      INSERT INTO testimony_intake (
        display_name, location, discovery_source, qr_code, format, short_quote,
        video_file_url, video_link_url, written_body, audio_url, photo_url, photo_caption,
        contact_email, consent_lord, consent_publish, status, admin_notes,
        social_instagram, social_tiktok, social_youtube,
        social_facebook, social_spotify, social_website
      ) VALUES (
        @display_name, @location, @discovery_source, @qr_code, 'video', @short_quote,
        NULL, NULL, NULL, NULL, NULL, NULL,
        @contact_email, @consent_lord, @consent_publish, 'pending', @admin_notes,
        @social_instagram, @social_tiktok, @social_youtube,
        @social_facebook, @social_spotify, @social_website
      )
    `);
    const featurePref = wants_feature
      ? 'Submitter consented to being featured publicly.'
      : 'Submitter did NOT consent to being featured publicly — keep Private/Unlisted.';
    const featureNote = '[AWAITING UPLOAD] ' + featurePref;
    const result = stmt.run({
      display_name, location, discovery_source, qr_code, short_quote,
      contact_email, consent_lord, consent_publish, admin_notes: featureNote,
      social_instagram, social_tiktok, social_youtube,
      social_facebook, social_spotify, social_website
    });

    return res.json({
      ok: true,
      intake_id: result.lastInsertRowid,
      upload_url: session.uploadUrl,
      privacy: session.privacy || privacyStatus
    });
  } catch (e) {
    console.error('youtube-init error:', e);
    return res.status(500).json({ error: 'Could not start video upload', message: e.message });
  }
});

// ---------- Direct-to-YouTube: STEP 2, finalize ----------
// Browser PUT the file to Google directly. When Google returns 200 with the video id,
// the browser POSTs back here so we can mark the intake row as pending review.
router.post('/youtube-finalize', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(500).json({ error: 'database not ready' });

    const b = req.body || {};
    const intakeId = Number(b.intake_id);
    const videoId = clean(b.video_id, 64);
    if (!Number.isFinite(intakeId) || intakeId <= 0) return res.status(400).json({ error: 'intake_id required' });
    if (!videoId) return res.status(400).json({ error: 'video_id required' });

    const row = db.prepare('SELECT id, status FROM testimony_intake WHERE id = ?').get(intakeId);
    if (!row) return res.status(404).json({ error: 'submission not found' });

    const video_link_url = `https://www.youtube.com/watch?v=${videoId}`;

    // Clear the [AWAITING UPLOAD] tag from admin_notes once the video lands.
    const cleanedNotes = db.prepare("SELECT admin_notes FROM testimony_intake WHERE id = ?").get(intakeId);
    const newNotes = cleanedNotes && cleanedNotes.admin_notes
      ? String(cleanedNotes.admin_notes).replace(/^\[AWAITING UPLOAD\]\s*/, '')
      : null;

    db.prepare(`
      UPDATE testimony_intake
         SET video_link_url = ?,
             status = 'pending',
             admin_notes = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(video_link_url, newNotes, intakeId);

    // Fire admin + thank-you emails now that the video is actually on YouTube
    try {
      const intakeRow = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(intakeId);
      fireMailFor(intakeRow);
    } catch (mailErr) {
      console.warn('[testimony-submit] mail load after finalize failed:', mailErr.message);
    }

    // Best-effort: add to Testimonials playlist. Non-fatal if it fails.
    if (yt && typeof yt.addVideoToTestimonialsPlaylist === 'function') {
      yt.addVideoToTestimonialsPlaylist(videoId).catch(err => {
        console.warn('[youtube-finalize] playlist attach failed:', err.message);
      });
    }

    return res.json({ ok: true, id: intakeId, status: 'pending', video_url: video_link_url });
  } catch (e) {
    console.error('youtube-finalize error:', e);
    return res.status(500).json({ error: 'Could not finalize submission', message: e.message });
  }
});

module.exports = router;
