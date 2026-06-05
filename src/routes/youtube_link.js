'use strict';

/**
 * Bridges the new YouTube testimony system to the existing QR/owner system.
 * (See repo history for full route doc.)
 */

const express = require('express');
const { getDb } = require('../db/client');
const yt = require('../services/youtubeService');

const router = express.Router();

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY || 'change-this-admin-key';
  if (!key || key !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'owner';
}

function uniqueSlug(db, base) {
  let slug = base;
  let n = 1;
  while (db.prepare('SELECT id FROM owner_profiles WHERE slug = ?').get(slug)) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

function logAudit(db, action, entity_type, entity_id, payload) {
  try {
    db.prepare(`INSERT INTO admin_audit_logs (action, entity_type, entity_id, payload_json)
      VALUES (?, ?, ?, ?)`).run(action, entity_type, entity_id, JSON.stringify(payload || {}));
  } catch (e) { /* table may not exist in older installs */ }
}

/* ============================================================
 * GET approve options
 * ============================================================ */
router.get('/admin/youtube/testimonies/:id/approve-options', adminAuth, (req, res) => {
  const db = getDb();
  const sub = db.prepare('SELECT * FROM testimony_video_uploads WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'submission not found' });

  let owners = [];
  if (sub.submitted_email) {
    owners = db.prepare(`SELECT id AS owner_id, slug AS owner_slug, display_name,
      public_video_url, embed_video_url, email
      FROM owner_profiles
      WHERE email = ? AND public_video_url IS NOT NULL AND public_video_url != ''
      ORDER BY updated_at DESC`).all(sub.submitted_email);
  }
  if (!owners.length && sub.submitted_name) {
    owners = db.prepare(`SELECT id AS owner_id, slug AS owner_slug, display_name,
      public_video_url, embed_video_url, email
      FROM owner_profiles
      WHERE LOWER(display_name) = LOWER(?) AND public_video_url IS NOT NULL AND public_video_url != ''
      ORDER BY updated_at DESC`).all(sub.submitted_name);
  }

  const codes = db.prepare(`SELECT c.id, c.item_code, c.owner_profile_id AS current_owner_id,
      o.display_name AS current_owner_name
    FROM testimony_item_codes c
    LEFT JOIN owner_profiles o ON o.id = c.owner_profile_id
    ORDER BY c.item_code ASC`).all();

  res.json({
    submission: sub,
    existing_owner_videos: owners,
    available_item_codes: codes
  });
});

/* ============================================================
 * POST approve-link
 * ============================================================ */
router.post('/admin/youtube/testimonies/:id/approve-link', adminAuth, async (req, res) => {
  const db = getDb();
  const sub = db.prepare('SELECT * FROM testimony_video_uploads WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'submission not found' });

  const body = req.body || {};
  const itemCodesRaw = Array.isArray(body.item_codes) ? body.item_codes
                       : (typeof body.item_codes === 'string' ? body.item_codes.split(/[,\s]+/) : []);
  const itemCodes = itemCodesRaw.map(s => String(s || '').trim().toUpperCase()).filter(Boolean);
  const useExisting = !!body.use_existing_owner_video;
  const existingOwnerId = body.existing_owner_id ? Number(body.existing_owner_id) : null;
  const makePublic = !!body.make_public;
  const adminNotes = body.admin_notes ? String(body.admin_notes).slice(0, 1000) : null;

  let publicUrl = sub.youtube_url;
  let embedUrl  = sub.youtube_embed_url;
  let chosenOwnerForVideo = null;

  if (useExisting) {
    if (!existingOwnerId) return res.status(400).json({ error: 'existing_owner_id required' });
    chosenOwnerForVideo = db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(existingOwnerId);
    if (!chosenOwnerForVideo) return res.status(404).json({ error: 'existing owner not found' });
    publicUrl = chosenOwnerForVideo.public_video_url;
    embedUrl  = chosenOwnerForVideo.embed_video_url;
  }

  if (!publicUrl) return res.status(400).json({ error: 'no video to link' });

  let owner;
  if (useExisting && chosenOwnerForVideo) {
    owner = chosenOwnerForVideo;
  } else {
    if (sub.submitted_email) {
      owner = db.prepare('SELECT * FROM owner_profiles WHERE email = ?').get(sub.submitted_email);
    }
    if (!owner && sub.submitted_name) {
      owner = db.prepare('SELECT * FROM owner_profiles WHERE LOWER(display_name) = LOWER(?)').get(sub.submitted_name);
    }
    if (!owner) {
      const baseSlug = slugify(sub.submitted_name || 'owner');
      const slug = uniqueSlug(db, baseSlug);
      const info = db.prepare(`INSERT INTO owner_profiles
        (slug, display_name, email, public_video_url, embed_video_url, short_quote, testimony_summary, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`).run(
        slug, sub.submitted_name || 'Anonymous', sub.submitted_email || null,
        publicUrl, embedUrl, null, sub.short_message || null
      );
      owner = db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(info.lastInsertRowid);
    } else {
      db.prepare(`UPDATE owner_profiles
        SET public_video_url = ?, embed_video_url = ?,
            testimony_summary = COALESCE(testimony_summary, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(publicUrl, embedUrl, sub.short_message || null, owner.id);
      owner = db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(owner.id);
    }
  }

  const attached = [];
  const skipped = [];
  for (const code of itemCodes) {
    let row = db.prepare('SELECT * FROM testimony_item_codes WHERE item_code = ?').get(code);
    if (!row) {
      const info = db.prepare(`INSERT INTO testimony_item_codes (item_code, owner_profile_id, destination_mode)
        VALUES (?, ?, 'owner_profile')`).run(code, owner.id);
      attached.push({ code, id: info.lastInsertRowid, was_new: true });
      continue;
    }
    db.prepare(`UPDATE testimony_item_codes
      SET owner_profile_id = ?, destination_mode = 'owner_profile', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(owner.id, row.id);
    attached.push({ code, id: row.id, was_new: false });
  }

  let finalPrivacy = sub.privacy_status || 'unlisted';
  if (makePublic && sub.permission_public && sub.youtube_video_id && !useExisting) {
    try {
      await yt.setVideoPrivacy(sub.youtube_video_id, 'public');
      finalPrivacy = 'public';
    } catch (e) { /* keep unlisted on failure */ }
  }

  db.prepare(`UPDATE testimony_video_uploads
    SET review_status='approved',
        admin_notes = COALESCE(?, admin_notes),
        privacy_status = ?,
        reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(adminNotes, finalPrivacy, sub.id);

  logAudit(getDb(), 'youtube_testimony_approve_link', 'testimony_video_uploads', sub.id, {
    owner_id: owner.id, attached, useExisting, makePublic, finalPrivacy
  });

  res.json({
    ok: true,
    owner: { id: owner.id, slug: owner.slug, display_name: owner.display_name,
             public_video_url: owner.public_video_url, embed_video_url: owner.embed_video_url },
    attached_codes: attached,
    skipped_codes: skipped,
    privacy_status: finalPrivacy
  });
});

/* ============================================================
 * PUBLIC: testimony wall — returns approved owners across ALL formats
 * (video, written, audio, photo). Multi-format columns are returned
 * with COALESCE so older rows missing those columns still work.
 * ============================================================ */
router.get('/public/testimony-wall', (req, res) => {
  const db = getDb();

  // Detect optional multi-format columns so the query works on either schema.
  const cols = db.prepare('PRAGMA table_info(owner_profiles)').all().map(c => c.name);
  const has = (c) => cols.includes(c);

  const selectParts = [
    'id',
    'display_name',
    'slug',
    'public_video_url',
    'embed_video_url',
    'short_quote',
    'testimony_summary',
    'updated_at',
    has('format')        ? 'format'        : `'video'  AS format`,
    has('written_body')  ? 'written_body'  : `NULL    AS written_body`,
    has('audio_url')     ? 'audio_url'     : `NULL    AS audio_url`,
    has('photo_url')     ? 'photo_url'     : `NULL    AS photo_url`,
    has('photo_caption') ? 'photo_caption' : `NULL    AS photo_caption`,
  ];

  const rows = db.prepare(`
    SELECT ${selectParts.join(', ')}
    FROM owner_profiles
    WHERE status = 'active'
    ORDER BY updated_at DESC
    LIMIT 48
  `).all();

  res.json({ items: rows });
});

module.exports = router;
