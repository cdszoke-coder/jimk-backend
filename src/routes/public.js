// src/routes/public.js — Adds /qr/:code/lookup for smart QR scan flow.

const express = require('express');
const { getDb } = require('../db/client');
const { ok, badRequest } = require('../utils/http');
const {
  getFounderPayload,
  resolveItemCode,
  createSubmission,
  listSubmissions
} = require('../services/testimonyService');
const {
  assertRequired,
  normalizeSubmissionPayload
} = require('../utils/validators');

const router = express.Router();
const { publicRouter: artistsPublicRouter } = require('./artists');

router.use(artistsPublicRouter);

router.get('/health', (req, res) => ok(res, { ok: true }));

router.get('/founder', (req, res) => {
  const db = getDb();
  return ok(res, { founder: getFounderPayload(db) });
});

router.get('/testimony/resolve', (req, res) => {
  const db = getDb();
  const result = resolveItemCode(db, req.query.shirt);
  return ok(res, result);
});

// Smart QR lookup: tells the client whether a scanned code is unused, linked to
// a wall record, or unknown. Used by story.html and testimony.html.
router.get('/qr/:code/lookup', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!code) return badRequest(res, 'missing_code');
  try {
    const db = getDb();

    // Step 1: is this code registered at all?
    let row = null;
    try {
      row = db.prepare(
        'SELECT item_code, owner_profile_id FROM testimony_item_codes WHERE item_code = ?'
      ).get(code);
    } catch (e) {
      return ok(res, { status: 'not_registered', code, owner: null, error: e.message });
    }

    if (!row) {
      // Unregistered code: still allow it to be used as a fresh tag.
      return ok(res, { status: 'not_registered', code, owner: null });
    }

    // Step 2: registered but no owner_profile_id yet -> unused
    if (!row.owner_profile_id) {
      return ok(res, { status: 'unused', code, owner: null });
    }

    // Step 3: linked -> fetch the owner profile so story.html can render it
    let owner = null;
    try {
      owner = db.prepare(`
        SELECT id, slug, display_name, location, short_quote,
               public_video_url, embed_video_url, format,
               written_body, audio_url, photo_url, photo_caption,
               status
          FROM owner_profiles
         WHERE id = ?
      `).get(row.owner_profile_id);
    } catch (e) {
      owner = null;
    }

    if (!owner || (owner.status && owner.status !== 'active')) {
      // Linked to a record that's archived/missing: treat as unused so admin can re-attach.
      return ok(res, { status: 'unused', code, owner: null });
    }

    return ok(res, { status: 'linked', code, owner });
  } catch (err) {
    return badRequest(res, err.message);
  }
});

router.post('/submissions', (req, res) => {
  try {
    const db = getDb();
    const payload = normalizeSubmissionPayload(req.body || {});
    assertRequired(['submitted_name', 'public_video_url'], payload);
    const submission = createSubmission(db, payload);
    return res.status(201).json({
      message: 'Submission received and queued for review',
      submission
    });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.get('/wall', (req, res) => {
  const db = getDb();
  const submissions = listSubmissions(db, { status: 'approved_new_owner', limit: 12 });
  return ok(res, { testimonies: submissions });
});

module.exports = router;
