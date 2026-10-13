// src/routes/shortLinks.js
// -----------------------------------------------------------------------------
// Short, type-in-friendly QR links:
//   /jimk-0007        -> https://www.jesusismykingmovement.com/story.html?id=<slug>
//   /share/0007       -> same
//
// Resolution order:
//   1. Code claimed (testimony_item_codes.item_code -> owner_profiles.slug,
//      status 'active')  -> 302 redirect to that testimony's story page.
//   2. Code not claimed yet (pre-printed shirt) -> 302 to
//      story.html?shirt=<code> so the existing claim flow takes over.
//   3. Anything that isn't a JIMK code -> next() so static/404 handle it.
//
// WIRE-UP (server.js): ABOVE express.static(publicDir) and the 404 catch-all:
//   const shortLinks = require('./src/routes/shortLinks');
//   app.use(shortLinks);
// -----------------------------------------------------------------------------

const express = require('express');
const { getDb } = require('../db/client');

const router = express.Router();

const SITE = (process.env.PUBLIC_SITE_BASE_URL || 'https://www.jesusismykingmovement.com')
  .replace(/\/+$/, '');

// Accepts: 0007, jimk-0007, JIMK-SHARE-0007, jimk_share_53 (etc.) -> JIMK-SHARE-0053
function normalizeCode(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toUpperCase();
  s = s.replace(/^JIMK[-_]?SHARE[-_]?/, '').replace(/^JIMK[-_]?/, '');
  if (!/^\d{1,4}$/.test(s)) return null;
  return 'JIMK-SHARE-' + s.padStart(4, '0');
}

function storyUrlFor(code) {
  const db = getDb();
  const row = db.prepare(`
    SELECT op.slug AS slug, op.status AS status
    FROM testimony_item_codes c
    JOIN owner_profiles op ON op.id = c.owner_profile_id
    WHERE c.item_code = ?
    LIMIT 1
  `).get(code);

  if (row && row.slug && row.status === 'active') {
    return `${SITE}/story.html?id=${encodeURIComponent(row.slug)}`;
  }
  // Unclaimed / archived: hand off to the shirt-code flow
  return `${SITE}/story.html?shirt=${encodeURIComponent(code)}`;
}

function handleShortLink(req, res, next) {
  const code = normalizeCode(req.params.n);
  if (!code) return next();
  try {
    res.redirect(302, storyUrlFor(code));
  } catch (err) {
    console.error('[shortLinks] lookup failed for', code, '-', err.message);
    res.redirect(302, `${SITE}/story.html?shirt=${encodeURIComponent(code)}`);
  }
}

// Route patterns are deliberately narrow so real pages (story.html, admin.html, ...)
// are never shadowed.
router.get('/jimk-:n', handleShortLink);
router.get('/share/:n', handleShortLink);

module.exports = router;
