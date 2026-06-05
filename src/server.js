'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const { initDatabase } = require('./db/client');

initDatabase();

const publicRoutes = require('./routes/public');
const adminRoutes  = require('./routes/admin');

function asRouter(mod, label) {
  if (!mod) return null;
  if (typeof mod === 'function') return mod;
  if (typeof mod.router === 'function') return mod.router;
  if (typeof mod.default === 'function') return mod.default;
  if (typeof mod.handle === 'function' && typeof mod.use === 'function') return mod;
  console.warn('[server] route file', label, 'did not export a single router. Will check for split exports.');
  return null;
}
function safeRequireRouter(p) {
  try { return asRouter(require(p), p); }
  catch (e) { console.warn('[server] optional route not loaded:', p, '-', e.message); return null; }
}
function safeRequireSplit(p) {
  try {
    const mod = require(p);
    return {
      publicRouter: (mod && typeof mod.publicRouter === 'function' && typeof mod.publicRouter.use === 'function') ? mod.publicRouter : null,
      adminRouter:  (mod && typeof mod.adminRouter  === 'function' && typeof mod.adminRouter.use  === 'function') ? mod.adminRouter  : null
    };
  } catch (e) {
    console.warn('[server] optional split route not loaded:', p, '-', e.message);
    return { publicRouter: null, adminRouter: null };
  }
}

// Simple admin-key middleware (header: x-admin-key) — used to protect the new
// admin testimony moderation route. Reads from process.env.ADMIN_API_KEY.
function adminAuth(req, res, next) {
  const key = req.get('x-admin-key') || req.query.admin_key || '';
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const corePublic              = asRouter(publicRoutes, './routes/public');
const coreAdmin               = asRouter(adminRoutes,  './routes/admin');
const artistsSplit            = safeRequireSplit('./routes/artists');         // { publicRouter, adminRouter }
const youtubeRoutes           = safeRequireRouter('./routes/youtube');
const artistYoutubeRoutes     = safeRequireRouter('./routes/artists_youtube');
const youtubeLinkRoutes       = safeRequireRouter('./routes/youtube_link');
const welcomeRoutes           = safeRequireRouter('./routes/welcome');
const testimonySubmitRoute    = safeRequireRouter('./routes/testimony-submit');
const adminTestimonyRoute     = safeRequireRouter('./routes/admin-testimony');
const adminYoutubeRoute       = safeRequireRouter('./routes/admin-youtube'); 
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/healthz', (req, res) => res.json({ ok: true, service: 'jimk-2qr-backend' }));

if (corePublic)                 app.use('/api/public', corePublic);
if (coreAdmin)                  app.use('/api/admin',  coreAdmin);
if (artistsSplit.publicRouter)  app.use('/api/public', artistsSplit.publicRouter);
if (artistsSplit.adminRouter)   app.use('/api/admin',  artistsSplit.adminRouter);
if (youtubeRoutes)              app.use('/api', youtubeRoutes);
if (artistYoutubeRoutes)        app.use('/api', artistYoutubeRoutes);
if (youtubeLinkRoutes)          app.use('/api', youtubeLinkRoutes);
if (welcomeRoutes)              app.use('/api', welcomeRoutes);

// Multi-format testimony submission (public) + admin moderation
if (testimonySubmitRoute)       app.use('/api/public/testimony', testimonySubmitRoute);
if (adminTestimonyRoute)        app.use('/api/admin/testimony-submissions', adminAuth, adminTestimonyRoute);

const uploadsDir = process.env.UPLOADS_DIR ||
  path.join((env && env.dataDir) || '/opt/render/project/src/data', 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));
  console.log('[server] serving /uploads from', uploadsDir);
} catch (e) {
  console.warn('[server] could not set up /uploads:', e.message);
}

// Expose the uploads dir to the testimony route so it writes into the same place
app.set('uploadsDir', uploadsDir);

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
