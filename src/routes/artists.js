const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { getDb } = require('../db/client');
const adminAuth = require('../middleware/adminAuth');
const { ok, badRequest, notFound } = require('../utils/http');
const {
  getArtistById,
  getArtistBySlug,
  listArtists,
  searchArtistsPaginated,
  createArtist,
  updateArtist,
  addArtistArtwork,
  getPublicArtistsDirectory,
  getArtistSiteSettings,
  updateArtistSiteSettings,
  ensureArtistUploadDir
} = require('../services/artistService');

const publicDir = path.join(__dirname, '..', '..', 'public');
const uploadDir = ensureArtistUploadDir(publicDir);

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpe?g|png|webp|gif)$/i.test(file.mimetype)) {
      return cb(new Error('Only image files (jpg, png, webp, gif) are allowed'));
    }
    cb(null, true);
  }
});

function randomFileName(extension = 'webp') {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
}

async function processAndSaveImage(buffer, artistSlug, options = {}) {
  const artistDir = path.join(uploadDir, artistSlug);
  fs.mkdirSync(artistDir, { recursive: true });
  const fileName = randomFileName('webp');
  const filePath = path.join(artistDir, fileName);
  const maxWidth = Number(options.max_width || 1600);
  const maxHeight = Number(options.max_height || 1600);
  await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality: 82 })
    .toFile(filePath);
  return `/uploads/artists/${artistSlug}/${fileName}`;
}

const publicRouter = express.Router();

publicRouter.get('/artists', (req, res) => {
  const db = getDb();
  return ok(res, getPublicArtistsDirectory(db));
});

publicRouter.get('/artists/:slug', (req, res) => {
  const db = getDb();
  const artist = getArtistBySlug(db, req.params.slug);
  if (!artist) return notFound(res, 'Artist not found');
  return ok(res, { artist });
});

const adminRouter = express.Router();
adminRouter.use(adminAuth);

adminRouter.get('/artists', (req, res) => {
  const db = getDb();
  return ok(res, searchArtistsPaginated(db, {
    query: req.query.query || '',
    status: req.query.status || 'all',
    page: req.query.page || 1,
    page_size: req.query.page_size || 20
  }));
});

adminRouter.get('/artists/:id', (req, res) => {
  const db = getDb();
  const artist = getArtistById(db, req.params.id);
  if (!artist) return notFound(res, 'Artist not found');
  return ok(res, { artist });
});

adminRouter.post('/artists', (req, res) => {
  try {
    const db = getDb();
    const artist = createArtist(db, req.body || {});
    return res.status(201).json({ artist });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

adminRouter.patch('/artists/:id', (req, res) => {
  try {
    const db = getDb();
    const artist = updateArtist(db, req.params.id, req.body || {});
    return ok(res, { artist });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

adminRouter.delete('/artists/:id/artwork', (req, res) => {
  try {
    const db = getDb();
    const artist = getArtistById(db, req.params.id);
    if (!artist) return notFound(res, 'Artist not found');
    const removeUrl = String((req.body && req.body.artwork_url) || req.query.artwork_url || '').trim();
    if (!removeUrl) return badRequest(res, 'artwork_url is required');
    const nextArtwork = artist.artwork_urls.filter(url => url !== removeUrl);
    const heroImageUrl = artist.hero_image_url === removeUrl
      ? (nextArtwork[0] || '')
      : artist.hero_image_url;
    const updated = updateArtist(db, req.params.id, {
      artwork_urls: nextArtwork,
      hero_image_url: heroImageUrl
    });
    if (removeUrl.startsWith('/uploads/artists/')) {
      const absolute = path.join(publicDir, removeUrl.replace(/^\/+/, ''));
      fs.promises.unlink(absolute).catch(() => {});
    }
    return ok(res, { artist: updated });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

adminRouter.post('/artists/:id/artwork', upload.array('images', 12), async (req, res) => {
  try {
    const db = getDb();
    const artist = getArtistById(db, req.params.id);
    if (!artist) return notFound(res, 'Artist not found');
    if (!req.files || !req.files.length) return badRequest(res, 'No image files received');
    const uploadedUrls = [];
    for (const file of req.files) {
      const url = await processAndSaveImage(file.buffer, artist.slug, {
        max_width: req.body.max_width || 1600,
        max_height: req.body.max_height || 1600
      });
      uploadedUrls.push(url);
    }
    const setAsHero = String(req.body.set_as_hero || '').toLowerCase() === 'true';
    const updated = addArtistArtwork(db, req.params.id, uploadedUrls, { set_as_hero: setAsHero });
    return res.status(201).json({ artist: updated, uploaded_urls: uploadedUrls });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

adminRouter.post('/artists/:id/hero', (req, res) => {
  try {
    const db = getDb();
    const heroUrl = String((req.body && req.body.hero_image_url) || '').trim();
    if (!heroUrl) return badRequest(res, 'hero_image_url is required');
    const updated = updateArtist(db, req.params.id, { hero_image_url: heroUrl });
    return ok(res, { artist: updated });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

adminRouter.get('/artists-settings', (req, res) => {
  const db = getDb();
  return ok(res, { settings: getArtistSiteSettings(db) });
});

adminRouter.patch('/artists-settings', (req, res) => {
  const db = getDb();
  return ok(res, { settings: updateArtistSiteSettings(db, req.body || {}) });
});

module.exports = { publicRouter, adminRouter };
