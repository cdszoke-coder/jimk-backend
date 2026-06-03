'use strict';

/**
 * Admin route: upload an artist testimony/feature video to YouTube and link it
 * to an artist record. The video is created as UNLISTED and added to the
 * "Artists" playlist on the connected YouTube channel.
 *
 * Endpoint:
 *   POST /api/admin/artists/:id/youtube-video   (multipart, field: video)
 *
 * Optional form fields:
 *   - title          (string, defaults to "<Artist Name> — Testimony")
 *   - description    (string)
 *   - make_public    ("1" to flip to Public after upload; otherwise stays Unlisted)
 *
 * Result: updates the artist record's public_video_url + embed_video_url to the
 * uploaded YouTube video, so the existing artist page renders it automatically.
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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB cap for artist videos
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

router.post('/admin/artists/:id/youtube-video', adminAuth, upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Please choose a video to upload.' });

  const db = getDb();
  const artist = db.prepare('SELECT * FROM artist_profiles WHERE id = ?').get(req.params.id);
  if (!artist) {
    fs.unlink(file.path, () => {});
    return res.status(404).json({ error: 'Artist not found.' });
  }

  const makePublic = req.body.make_public === '1' || req.body.make_public === 'true';
  const title = (req.body.title || `${artist.display_name} — Testimony`).toString().slice(0, 100);
  const description = (req.body.description ||
    `Artist feature for ${artist.display_name} — Jesus Is My King Movement.`).toString().slice(0, 4500);

  try {
    if (!yt.isConnected()) {
      throw new Error('YouTube is not connected yet. Connect it in the YouTube panel first.');
    }

    // Step 1: upload to YouTube as Unlisted
    const ytRes = await yt.uploadVideoFromPath(file.path, {
      title,
      description,
      privacyStatus: 'unlisted',
      tags: ['artist', 'testimony', 'jesusismykingmovement']
    });

    const videoId = ytRes.id;
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const embedUrl = `https://www.youtube.com/embed/${videoId}`;

    // Step 2: add to "Artists" playlist
    let added = false;
    try {
      await yt.addVideoToArtistsPlaylist(videoId);
      added = true;
    } catch (e) { /* non-fatal */ }

    // Step 3: optionally flip to Public
    let privacyStatus = 'unlisted';
    if (makePublic) {
      try {
        await yt.setVideoPrivacy(videoId, 'public');
        privacyStatus = 'public';
      } catch (e) { /* leave unlisted */ }
    }

    // Step 4: update the artist record so the existing artist page renders it
    db.prepare(`UPDATE artist_profiles
      SET public_video_url = ?, embed_video_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(watchUrl, embedUrl, artist.id);

    res.json({
      ok: true,
      video_id: videoId,
      public_video_url: watchUrl,
      embed_video_url: embedUrl,
      privacy_status: privacyStatus,
      added_to_artists_playlist: added
    });
  } catch (err) {
    console.error('artist youtube upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed.' });
  } finally {
    if (file && file.path) fs.unlink(file.path, () => {});
  }
});

// Clear the testimony video off an artist (does NOT delete from YouTube).
router.post('/admin/artists/:id/youtube-video/clear', adminAuth, (req, res) => {
  const db = getDb();
  const artist = db.prepare('SELECT * FROM artist_profiles WHERE id = ?').get(req.params.id);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });
  db.prepare(`UPDATE artist_profiles
    SET public_video_url = NULL, embed_video_url = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(artist.id);
  res.json({ ok: true });
});

module.exports = router;
