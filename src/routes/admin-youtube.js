// src/routes/admin-youtube.js
// Layer 2a: YouTube connection status + OAuth start for admin moderation panel.
// Endpoints (all guarded by admin-key middleware applied in server.js):
//   GET  /api/admin/youtube/status     -> { connected, channel_title, scopes, expires_at }
//   GET  /api/admin/youtube/auth-url   -> { url }  (admin redirects browser to this URL to authorize)
//   POST /api/admin/youtube/disconnect -> { ok: true }  (clears stored tokens)
//
// OAuth callback itself lives at /api/public/youtube/oauth/callback (handled elsewhere,
// per permanent constraint #6 — never under /api/admin).

const express = require('express');

const router = express.Router();

let yt = null;
try {
  yt = require('../services/youtubeService');
} catch (err) {
  console.warn('[admin-youtube] youtubeService not loaded:', err.message);
}

function ensureService(res) {
  if (!yt) {
    res.status(503).json({ error: 'YouTube service unavailable' });
    return false;
  }
  return true;
}

router.get('/status', (req, res) => {
  if (!ensureService(res)) return;
  try {
    const connected = typeof yt.isConnected === 'function' ? yt.isConnected() : false;
    let info = null;
    if (connected && typeof yt.getConnectionInfo === 'function') {
      info = yt.getConnectionInfo();
    }
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
    if (typeof yt.getAuthUrl !== 'function') {
      return res.status(500).json({ error: 'getAuthUrl_missing' });
    }
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
    if (typeof yt.disconnect === 'function') {
      yt.disconnect();
      return res.json({ ok: true });
    }
    // Fallback: clear via raw DB if disconnect() isn't exported
    const { getDb } = require('../db/client');
    const db = getDb();
    db.prepare("DELETE FROM youtube_oauth_tokens").run();
    res.json({ ok: true, note: 'cleared via raw DB' });
  } catch (err) {
    console.error('[admin-youtube] disconnect error:', err);
    res.status(500).json({ error: 'disconnect_failed', message: err.message });
  }
});

module.exports = router;
