// src/routes/admin-youtube.js
// Layer 2: YouTube connection + one-click upload for admin moderation panel.
// All endpoints guarded by the admin-key middleware applied in server.js.
//
//   GET  /api/admin/youtube/status                           -> { connected, channel_title, ... }
//   GET  /api/admin/youtube/auth-url                         -> { url }
//   POST /api/admin/youtube/disconnect                       -> { ok: true }
//   POST /api/admin/youtube/upload/:submissionId             -> { ok, video_id, video_url, privacy }
//   POST /api/admin/youtube/videos/:videoId/privacy          -> { ok, privacy }
//
// OAuth callback lives at /api/public/youtube/oauth/callback (constraint #6).

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

let yt = null;
try {
  yt = require('../services/youtubeService');
} catch (err) {
  console.warn('[admin-youtube] youtubeService not loaded:', err.message);
}

function ensureService(res) {
  if (!yt) { res.status(503).json({ error: 'YouTube service unavailable' }); return false; }
  return true;
}

function getDbSafe() {
  try { return require('../db/client').getDb(); } catch (e) { return null; }
}

router.get('/status', (req, res) => {
  if (!ensureService(res)) return;
  try {
    const connected = typeof yt.isConnected === 'function' ? yt.isConnected() : false;
    let info = null;
    if (connected && typeof yt.getConnectionInfo === 'function') info = yt.getConnectionInfo();
    res.json({
      connected: !!connected,
      channel_title: info && info.channel_title ? info.channel_title : null,
      scopes: info && info.scopes ? info.scopes : null,
      expires_at: info && info.expires_at ? info.expires_at : null,
      testimonials_playlist_id: info && info.testimonials_playlist_id ? info.testimonials_playlist_id : null,
      artists_playlist_id: info && info.artists_playlist_id ? info.artists_playlist_id : null
    });
  } catch (err) {
    console.error('[admin-youtube] status error:', err);
    res.status(500).json({ error: 'status_failed', message: err.message });
  }
});

router.get('/auth-url', (req, res) => {
  if (!ensureService(res)) return;
  try {
    if (typeof yt.getAuthUrl !== 'function') return res.status(500).json({ error: 'getAuthUrl_missing' });
    const url = yt.getAuthUrl();
    if (!url) return res.status(500).json({ error: 'empty_auth_url' });
    res.json({ url });
  } catch (err) {
    console.error('[admin-youtube] auth-url error:', err);
    res.status(500).json({ error: 'auth_url_failed', message: err.message });
  }
});

router.post('/disconnect', (req, res) => {
  if (!ensureService(res)) return;
  try {
    if (typeof yt.disconnect === 'function') { yt.disconnect(); return res.json({ ok: true }); }
    const db = getDbSafe();
    if (db) { db.prepare("DELETE FROM youtube_oauth_tokens").run(); return res.json({ ok: true, note: 'cleared via raw DB' }); }
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin-youtube] disconnect error:', err);
    res.status(500).json({ error: 'disconnect_failed', message: err.message });
  }
});

// Resolve an /uploads-style URL or filename to an absolute path on disk
function resolveUploadPath(value) {
  if (!value) return null;
  let p = String(value).trim();
  // Strip absolute backend URL prefix if present
  p = p.replace(/^https?:\/\/[^/]+/, '');
  // Strip leading /uploads/ prefix
  p = p.replace(/^\/?uploads\//, '');
  // Reject anything trying to escape the uploads dir
  if (p.includes('..')) return null;
  const uploadsDir = path.resolve(process.env.UPLOADS_DIR || '/opt/render/project/src/data/uploads');
  const abs = path.resolve(uploadsDir, p);
  if (!abs.startsWith(uploadsDir)) return null; // path traversal guard
  if (!fs.existsSync(abs)) return null;
  return abs;
}

router.post('/upload/:submissionId', async (req, res) => {
  if (!ensureService(res)) return;
  const db = getDbSafe();
  if (!db) return res.status(503).json({ error: 'database_unavailable' });

  const id = Number(req.params.submissionId);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'bad_submission_id' });

  let row;
  try {
    row = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(id);
  } catch (err) {
    return res.status(500).json({ error: 'db_read_failed', message: err.message });
  }
  if (!row) return res.status(404).json({ error: 'submission_not_found' });
  if (row.format !== 'video') return res.status(400).json({ error: 'not_a_video_submission', format: row.format });
  if (row.video_file_url == null || row.video_file_url === '') {
    return res.status(400).json({ error: 'no_uploaded_video_file', hint: 'This submission was sent as a YouTube link, not an uploaded file. Paste the URL in the modal instead.' });
  }

  const localPath = resolveUploadPath(row.video_file_url);
  if (!localPath) return res.status(404).json({ error: 'video_file_missing_on_disk', value: row.video_file_url });

  // Default privacy = Unlisted; only Public when caller explicitly opts in
  const requested = String((req.body && req.body.privacy) || 'unlisted').toLowerCase();
  const allowed = new Set(['unlisted', 'public', 'private']);
  const privacy = allowed.has(requested) ? requested : 'unlisted';

  const displayName = row.display_name || 'Shared Testimony';
  const location = row.location ? ` — ${row.location}` : '';
  const title = `Shared Testimony: ${displayName}${location}`;
  const description = [
    row.short_quote ? `"${row.short_quote}"` : '',
    '',
    'Shared through JESUS IS MY KING MOVEMENT.',
    'Post your testimony: https://www.jesusismykingmovement.com/testimony.html'
  ].filter(Boolean).join('\n');

  try {
    const result = await yt.uploadVideoFromPath(localPath, {
      title,
      description,
      privacyStatus: privacy,
      tags: ['testimony', 'jesusismykingmovement', 'sharedtestimony']
    });
    const videoId = result && result.id;
    if (!videoId) throw new Error('upload returned no video id');

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const embedUrl = `https://www.youtube.com/embed/${videoId}`;

    // Attach to Testimonials playlist (best-effort, non-fatal)
    try {
      if (typeof yt.addVideoToTestimonialsPlaylist === 'function') {
        await yt.addVideoToTestimonialsPlaylist(videoId);
      }
    } catch (plErr) {
      console.warn('[admin-youtube] playlist attach failed:', plErr.message);
    }

    // Write the new URL back to testimony_intake so Approve & Publish picks it up
    try {
      db.prepare(`
        UPDATE testimony_intake
           SET video_link_url = ?,
               updated_at = datetime('now')
         WHERE id = ?
      `).run(videoUrl, id);
    } catch (uErr) {
      console.warn('[admin-youtube] db update failed:', uErr.message);
    }

    res.json({
      ok: true,
      video_id: videoId,
      video_url: videoUrl,
      embed_url: embedUrl,
      privacy
    });
  } catch (err) {
    console.error('[admin-youtube] upload error:', err);
    res.status(500).json({ error: 'upload_failed', message: err.message });
  }
});

router.post('/videos/:videoId/privacy', async (req, res) => {
  if (!ensureService(res)) return;
  const videoId = String(req.params.videoId || '').trim();
  if (!videoId) return res.status(400).json({ error: 'bad_video_id' });
  const requested = String((req.body && req.body.privacy) || 'unlisted').toLowerCase();
  const allowed = new Set(['unlisted', 'public', 'private']);
  const privacy = allowed.has(requested) ? requested : 'unlisted';
  try {
    if (typeof yt.setVideoPrivacy !== 'function') return res.status(500).json({ error: 'setVideoPrivacy_missing' });
    await yt.setVideoPrivacy(videoId, privacy);
    res.json({ ok: true, video_id: videoId, privacy });
  } catch (err) {
    console.error('[admin-youtube] set privacy error:', err);
    res.status(500).json({ error: 'set_privacy_failed', message: err.message });
  }
});

module.exports = router;
