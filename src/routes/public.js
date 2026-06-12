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

// Owner-by-slug lookup: used by story.html?id=<slug> (wall-card click target).
// Returns the same shape as items in /testimony-wall so the frontend renderer
// works for any format (video / written / audio / photo) and surfaces socials
// when the submitter opted in. Active owners only.
router.get('/owner/:slug', (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!slug) return badRequest(res, 'missing_slug');
  try {
    const db = getDb();

    // Detect optional columns so the query works on either schema (legacy or post-Drop-1).
    const cols = db.prepare('PRAGMA table_info(owner_profiles)').all().map(c => c.name);
    const has = (c) => cols.includes(c);

    const selectParts = [
      'id',
      'display_name',
      'slug',
      'location',
      'public_video_url',
      'embed_video_url',
      'short_quote',
      'testimony_summary',
      'updated_at',
      has('format')           ? 'format'           : "'video' AS format",
      has('written_body')     ? 'written_body'     : 'NULL    AS written_body',
      has('audio_url')        ? 'audio_url'        : 'NULL    AS audio_url',
      has('photo_url')        ? 'photo_url'        : 'NULL    AS photo_url',
      has('photo_caption')    ? 'photo_caption'    : 'NULL    AS photo_caption',
      // Opt-in social columns. Returned for story-page rendering. NULL when blank.
      has('social_instagram') ? 'social_instagram' : 'NULL    AS social_instagram',
      has('social_tiktok')    ? 'social_tiktok'    : 'NULL    AS social_tiktok',
      has('social_youtube')   ? 'social_youtube'   : 'NULL    AS social_youtube',
      has('social_facebook')  ? 'social_facebook'  : 'NULL    AS social_facebook',
      has('social_spotify')   ? 'social_spotify'   : 'NULL    AS social_spotify',
      has('social_website')   ? 'social_website'   : 'NULL    AS social_website',
      'status'
    ];

    const row = db.prepare(`
      SELECT ${selectParts.join(', ')}
        FROM owner_profiles
       WHERE slug = ? AND status = 'active'
       LIMIT 1
    `).get(slug);

    if (!row) return res.status(404).json({ error: 'not_found', slug });

    // Surface every shirt code attached to this owner so the story page can
    // display the identifier(s). Users who lost their code can find it here
    // and use it later to link a new shirt to the same testimony.
    try {
      const codeRows = db.prepare(
        'SELECT item_code FROM testimony_item_codes WHERE owner_profile_id = ? ORDER BY item_code ASC'
      ).all(row.id);
      row.linked_item_codes = codeRows.map(r => r.item_code);
    } catch (_) {
      row.linked_item_codes = [];
    }

    // Tag mode so story.js renders the 'Shared Testimony' kicker.
    row.mode = 'owner_profile';
    return ok(res, row);
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
