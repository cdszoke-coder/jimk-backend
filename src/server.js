'use strict';

/**
 * JIMK backend server — drop-in version with ALL routes wired,
 * handling both `module.exports = router` and `module.exports = { router, ... }`.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const { initDatabase } = require('./db/client');

initDatabase();

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

// Accept both export styles:
//   module.exports = router                  (function)
//   module.exports = { router, ...helpers }  (object with .router)
function asRouter(mod, label) {
  if (!mod) return null;
  if (typeof mod === 'function') return mod;
  if (typeof mod.router === 'function') return mod.router;
  if (typeof mod.default === 'function') return mod.default;
  if (typeof mod.handle === 'function' && typeof mod.use === 'function') return mod;
  console.warn('[server] route file', label, 'did not export a router. Skipping.');
  return null;
}
function safeRequireRouter(p) {
  try {
    return asRouter(require(p), p);
  } catch (e) {
    console.warn('[server] optional route not loaded:', p, '-', e.message);
    return null;
  }
}

const corePublic           = asRouter(publicRoutes, './routes/public');
const coreAdmin            = asRouter(adminRoutes,  './routes/admin');
const artistsRoutes        = safeRequireRouter('./routes/artists');
const youtubeRoutes        = safeRequireRouter('./routes/youtube');
const artistYoutubeRoutes  = safeRequireRouter('./routes/artists_youtube');
const youtubeLinkRoutes    = safeRequireRouter('./routes/youtube_link');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'jimk-2qr-backend' }));

if (corePublic)          app.use('/api/public', corePublic);
if (coreAdmin)           app.use('/api/admin',  coreAdmin);
if (artistsRoutes)       app.use('/api', artistsRoutes);
if (youtubeRoutes)       app.use('/api', youtubeRoutes);
if (artistYoutubeRoutes) app.use('/api', artistYoutubeRoutes);
if (youtubeLinkRoutes)   app.use('/api', youtubeLinkRoutes);

const uploadsDir = process.env.UPLOADS_DIR ||
  path.join((env && env.dataDir) || '/opt/render/project/src/data', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));
  console.log('[server] serving /uploads from', uploadsDir);
} catch (e) {
  console.warn('[server] could not set up /uploads:', e.message);
}

const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  console.error('[server] error:', err);
  res.status(err.status || 500).json({ error: err.message || 'server error' });
});

const port = (env && env.port) || process.env.PORT || 8787;
app.listen(port, () => console.log('[server] listening on', port));
