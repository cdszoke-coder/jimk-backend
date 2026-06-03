'use strict';

/**
 * Public + admin routes for YouTube-based testimony video uploads.
 * - Public:
 *    POST /api/public/testimony-video   (multipart, field: video)
 * - Admin (requires x-admin-key):
 *    GET  /api/admin/youtube/status
 *    GET  /api/admin/youtube/auth-url
 *    GET  /api/public/youtube/oauth/callback      (Google redirects here — public path so admin auth does not block it)
 *    POST /api/admin/youtube/disconnect
 *    GET  /api/admin/youtube/testimonies?status=pending|approved|rejected|all
 *    POST /api/admin/youtube/testimonies/:id/approve
 *    POST /api/admin/youtube/testimonies/:id/reject
 *    POST /api/admin/youtube/testimonies/:id/make-public
 *    POST /api/admin/youtube/testimonies/:id/make-unlisted
 *    POST /api/admin/youtube/playlist/ensure
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const { getDb } = require('../db/client');
const yt = require('../services/youtubeService');

const router = express.Router();

const TMP_DIR = process.env.YT_TMP_DIR || path.join(os.tmpdir(), 'jimk_yt_uploads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB max raw upload
  fileFilter: (req, file, cb) => {
    const ok = /^video\//.test(file.mimetype) ||
               /\.(mp4|mov|m4v|webm|avi|3gp|mkv|heic|heif|hevc)$/i.test(file.originalname);
    if (!ok) return cb(new Error('Please upload a video file.'));
    cb(null, true);
  }
});

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY || 'change-this-admin-key';
  if (!key || key !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/* ============================================================
 * PUBLIC: Submit a testimony video from a phone
 * ============================================================ */
router.post('/public/testimony-video', upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Please choose a video to upload.' });

  const submitted_name = (req.body.name || '').toString().trim().slice(0, 120) || 'Anonymous';
  const submitted_email = (req.body.email || '').toString().trim().slice(0, 200) || null;
  const short_message = (req.body.message || '').toString().trim().slice(0, 800) || null;
  const permission_public = req.body.permission_public === '1' || req.body.permission_public === 'true' ? 1 : 0;

  try {
    if (!yt.isConnected()) {
      throw new Error('Video upload is not available right now. Please try again later.');
    }

    // Upload to YouTube immediately as UNLISTED (safe default)
    const title = `Testimony — ${submitted_name}`;
    const description = (short_message ? short_message + '\n\n' : '') +
      'Submitted to the Jesus Is My King Movement.';
    const ytRes = await yt.uploadVideoFromPath(file.path, {
      title,
      description,
      privacyStatus: 'unlisted'
    });

    const videoId = ytRes.id;
    const youtube_url = `https://www.youtube.com/watch?v=${videoId}`;
    const youtube_embed_url = `https://www.youtube.com/embed/${videoId}`;

    // Try to add to Testimonials playlist
    let added = 0;
    try {
      await yt.addVideoToTestimonialsPlaylist(videoId);
      added = 1;
    } catch (e) { /* non-fatal */ }

    const db = getDb();
    const info = db.prepare(`INSERT INTO testimony_video_uploads
      (submitted_name, submitted_email, permission_public, short_message,
       youtube_video_id, youtube_url, youtube_embed_url,
       privacy_status, added_to_testimonials_playlist, review_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'unlisted', ?, 'pending')`).run(
      submitted_name, submitted_email, permission_public, short_message,
      videoId, youtube_url, youtube_embed_url, added
    );

    res.json({
      ok: true,
      message: 'Thank you! Your testimony has been received and will be reviewed shortly.',
      id: info.lastInsertRowid
    });
  } catch (err) {
    console.error('testimony-video error:', err);
    res.status(500).json({ error: 'Sorry, your upload could not be completed. Please try again.' });
  } finally {
    if (file && file.path) {
      fs.unlink(file.path, () => {});
    }
  }
});

/* ============================================================
 * ADMIN: YouTube connection
 * ============================================================ */
router.get('/admin/youtube/status', adminAuth, (req, res) => {
  res.json(yt.getConnectionInfo());
});

router.get('/admin/youtube/auth-url', adminAuth, (req, res) => {
  try {
    res.json({ url: yt.getAuthUrl() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Google redirects here (NO admin key — this is called by the browser after consent).
// IMPORTANT: this MUST live under /api/public/... so any global admin-auth middleware
// on /api/admin/... does not block Google's redirect.
router.get('/public/youtube/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing authorization code.');
  try {
    await yt.exchangeCodeForTokens(code);
    // Try to ensure Testimonials playlist exists right away
    try { await yt.findOrCreateTestimonialsPlaylist(); } catch (e) {}
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>YouTube Connected</title>
      <style>body{font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:24px;color:#222}
      .ok{background:#0a7d2c;color:#fff;padding:14px 18px;border-radius:10px;font-weight:600}
      a{color:#6b21a8}</style></head><body>
      <div class="ok">YouTube is now connected.</div>
      <p>You can close this tab and return to the admin dashboard.</p>
      <p><a href="/admin.html">Back to Admin Dashboard</a></p>
      </body></html>`);
  } catch (err) {
    res.status(500).send('YouTube connection failed: ' + err.message);
  }
});

router.post('/admin/youtube/disconnect', adminAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM youtube_oauth_tokens').run();
  res.json({ ok: true });
});

router.post('/admin/youtube/playlist/ensure', adminAuth, async (req, res) => {
  try {
    const id = await yt.findOrCreateTestimonialsPlaylist();
    res.json({ ok: true, playlist_id: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
 * ADMIN: Testimony video moderation
 * ============================================================ */
router.get('/admin/youtube/testimonies', adminAuth, (req, res) => {
  const status = (req.query.status || 'pending').toString();
  const db = getDb();
  let rows;
  if (status === 'all') {
    rows = db.prepare(`SELECT * FROM testimony_video_uploads
      ORDER BY created_at DESC LIMIT 200`).all();
  } else {
    rows = db.prepare(`SELECT * FROM testimony_video_uploads
      WHERE review_status = ? ORDER BY created_at DESC LIMIT 200`).all(status);
  }
  res.json({ items: rows });
});

router.post('/admin/youtube/testimonies/:id/approve', adminAuth, async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM testimony_video_uploads WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const adminNotes = (req.body && req.body.admin_notes) ? String(req.body.admin_notes).slice(0, 1000) : null;
  const setPublic = !!(req.body && req.body.make_public);

  let newPrivacy = row.privacy_status || 'unlisted';
  if (setPublic && row.permission_public) {
    try {
      await yt.setVideoPrivacy(row.youtube_video_id, 'public');
      newPrivacy = 'public';
    } catch (e) { /* keep unlisted on failure */ }
  }

  db.prepare(`UPDATE testimony_video_uploads
    SET review_status='approved', admin_notes=COALESCE(?, admin_notes),
        privacy_status=?, reviewed_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(adminNotes, newPrivacy, row.id);

  res.json({ ok: true, privacy_status: newPrivacy });
});

router.post('/admin/youtube/testimonies/:id/reject', adminAuth, async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM testimony_video_uploads WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const adminNotes = (req.body && req.body.admin_notes) ? String(req.body.admin_notes).slice(0, 1000) : null;
  const removeFromYouTube = !!(req.body && req.body.delete_from_youtube);

  if (removeFromYouTube && row.youtube_video_id) {
    try { await yt.deleteVideo(row.youtube_video_id); } catch (e) {}
  } else if (row.youtube_video_id) {
    try { await yt.setVideoPrivacy(row.youtube_video_id, 'private'); } catch (e) {}
  }

  db.prepare(`UPDATE testimony_video_uploads
    SET review_status='rejected', admin_notes=COALESCE(?, admin_notes),
        privacy_status='private', reviewed_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(adminNotes, row.id);

  res.json({ ok: true });
});

router.post('/admin/youtube/testimonies/:id/make-public', adminAuth, async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM testimony_video_uploads WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    await yt.setVideoPrivacy(row.youtube_video_id, 'public');
    db.prepare(`UPDATE testimony_video_uploads SET privacy_status='public' WHERE id=?`).run(row.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/youtube/testimonies/:id/make-unlisted', adminAuth, async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM testimony_video_uploads WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    await yt.setVideoPrivacy(row.youtube_video_id, 'unlisted');
    db.prepare(`UPDATE testimony_video_uploads SET privacy_status='unlisted' WHERE id=?`).run(row.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// NOTE: /public/testimony-wall is intentionally NOT defined here.
// The correct wall endpoint (which reads from owner_profiles after Approve & link)
// lives in src/routes/youtube_link.js so it shows linked testimonies with display_name + embed_video_url.

module.exports = router;
