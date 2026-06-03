'use strict';

/**
 * JIMK backend server — drop-in version with ALL routes wired:
 *   - existing public + admin routes (testimony / owners / item codes)
 *   - artist routes (HEIC support + artwork on /data disk)
 *   - YouTube testimony upload routes
 *   - Artist YouTube upload routes
 *   - YouTube approve-and-link (multi-code) + public testimony wall
 *
 * Safe to overwrite your existing src/server.js.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const { initDatabase } = require('./db/client');

// --- Initialize DB up-front (creates tables if missing) ---
initDatabase();

// --- Routes ---
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

// Optional routes (load defensively so missing files don't crash boot)
function safeRequire(p) {
  try { return require(p); } catch (e) {
    console.warn('[server] optional route not loaded:', p, '-', e.message);
    return null;
  }
}
const artistsRoutes        = safeRequire('./routes/artists');
const youtubeRoutes        = safeRequire('./routes/youtube');
const artistYoutubeRoutes  = safeRequire('./routes/artists_youtube');
const youtubeLinkRoutes    = safeRequire('./routes/youtube_link');

// --- App ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'jimk-2qr-backend' }));

// Core routes
app.use('/api/public', publicRoutes);
app.use('/api/admin', adminRoutes);

// Optional routes (mount at /api — each router uses its own /public/... or /admin/... paths internally)
if (artistsRoutes)        app.use('/api', artistsRoutes);
if (youtubeRoutes)        app.use('/api', youtubeRoutes);
if (artistYoutubeRoutes)  app.use('/api', artistYoutubeRoutes);
if (youtubeLinkRoutes)    app.use('/api', youtubeLinkRoutes);

// Serve uploaded artwork from the persistent disk
const uploadsDir = process.env.UPLOADS_DIR ||
  path.join(env.dataDir || '/opt/render/project/src/data', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));
  console.log('[server] serving /uploads from', uploadsDir);
} catch (e) {
  console.warn('[server] could not set up /uploads:', e.message);
}

// Serve static admin dashboard
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// 404 + error handlers
app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  console.error('[server] error:', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'server error' });
});

const port = env.port || process.env.PORT || 8787;
app.listen(port, () => {
  console.log('[server] listening on', port);
});
