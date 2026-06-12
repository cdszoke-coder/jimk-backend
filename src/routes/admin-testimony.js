// routes/admin-testimony.js
// Admin moderation for multi-format testimony submissions stored in testimony_intake.
// Approve creates an owner_profile (wall record) and attaches selected QR codes.
// Reject / Archive also hide the linked wall record so it falls off the public wall.
// Also exposes simple wall-cleanup endpoints for archiving owner_profiles records.

const express = require('express');
const { getDb } = require('../db/client');
const router = express.Router();

let mail = null;
try { mail = require('../services/mailService'); }
catch (err) { console.warn('[admin-testimony] mailService not loaded:', err.message); }

function codesForOwner(db, ownerId) {
  try {
    const rows = db.prepare(
      'SELECT item_code FROM testimony_item_codes WHERE owner_profile_id = ? ORDER BY item_code'
    ).all(ownerId);
    return rows.map(r => r.item_code);
  } catch (e) { return []; }
}

function fireDecisionEmail(db, intakeRow, decision, ownerId) {
  if (!mail || !intakeRow) return;
  setImmediate(async () => {
    try {
      let owner = null;
      let qrCodes = [];
      if (ownerId) {
        owner = db.prepare('SELECT id, slug, display_name FROM owner_profiles WHERE id = ?').get(ownerId);
        qrCodes = codesForOwner(db, ownerId);
      }
      await mail.sendDecision({ intake: intakeRow, decision, owner, qrCodes });
    } catch (e) {
      console.warn('[admin-testimony] decision mail failed:', e.message);
    }
  });
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'testimony';
}

function uniqueSlug(db, base) {
  let slug = base;
  let n = 1;
  while (db.prepare('SELECT 1 AS ok FROM owner_profiles WHERE slug = ?').get(slug)) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

function youtubeEmbed(url) {
  if (!url) return '';
  const yt = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vm = String(url).match(/vimeo\.com\/(\d+)/);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return url;
}

function hideLinkedOwnerProfile(db, intakeRow) {
  if (!intakeRow || !intakeRow.approved_owner_id) return;
  db.prepare(`
    UPDATE owner_profiles
    SET status = 'archived', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(intakeRow.approved_owner_id);
}

router.get('/', (req, res) => {
  const db = getDb();
  const status = req.query.status || 'pending';
  const rows = db.prepare(`
    SELECT * FROM testimony_intake
    WHERE status = ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(status);
  res.json({ items: rows });
});

router.get('/:id(\\d+)', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ item: row });
});

router.patch('/:id(\\d+)', (req, res) => {
  const db = getDb();
  const { admin_notes, short_quote, status, video_link_url } = req.body || {};
  const allowed = ['pending','approved','rejected','archived'];
  const intake = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(req.params.id);
  if (!intake) return res.status(404).json({ error: 'Not found' });

  const fields = [];
  const vals = [];
  if (admin_notes !== undefined) { fields.push('admin_notes = ?'); vals.push(String(admin_notes || '').slice(0, 2000)); }
  if (short_quote !== undefined) { fields.push('short_quote = ?'); vals.push(String(short_quote || '').slice(0, 200)); }
  if (video_link_url !== undefined) { fields.push('video_link_url = ?'); vals.push(String(video_link_url || '').slice(0, 600)); }
  if (status !== undefined) {
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Bad status' });
    fields.push('status = ?'); vals.push(status);
  }
  if (!fields.length) return res.json({ ok: true });
  fields.push(`updated_at = datetime('now')`);
  vals.push(req.params.id);
  db.prepare(`UPDATE testimony_intake SET ${fields.join(', ')} WHERE id = ?`).run(...vals);

  if (status === 'rejected' || status === 'archived') {
    hideLinkedOwnerProfile(db, intake);
  }

  // Fire decision email on rejection (approval is fired by the approve route).
  if (status === 'rejected') {
    fireDecisionEmail(db, intake, 'rejected', intake.approved_owner_id || null);
  }

  res.json({ ok: true });
});

router.post('/:id(\\d+)/approve', (req, res) => {
  const db = getDb();
  const sub = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (sub.status === 'approved') return res.status(400).json({ error: 'Already approved' });

  const body = req.body || {};
  const item_codes = Array.isArray(body.item_codes) ? body.item_codes : [];
  const cleanCodes = Array.from(new Set(
    item_codes.map(c => String(c || '').trim().toUpperCase()).filter(Boolean)
  ));

  try {
    const tx = db.transaction(() => {
      let ownerId = body.reuse_owner_id ? Number(body.reuse_owner_id) : null;

      if (!ownerId) {
        const display_name = String(body.display_name || sub.display_name || '').trim() || 'Anonymous';
        const location     = String(body.location || sub.location || '').trim() || null;
        const short_quote  = String(body.short_quote || sub.short_quote || '').trim() || null;
        const slug = uniqueSlug(db, slugify(display_name));

        const fmt = sub.format || 'video';
        let public_video_url = '';
        let embed_video_url  = '';
        if (fmt === 'video') {
          public_video_url = sub.video_link_url || sub.video_file_url || '';
          embed_video_url  = youtubeEmbed(public_video_url) || public_video_url || '';
        }

        // Build the INSERT dynamically so we only reference social columns if they
        // exist on this DB. Keeps the route compatible with pre-migration schemas.
        const ownerCols = db.prepare('PRAGMA table_info(owner_profiles)').all().map(c => c.name);
        const ownerHas = (c) => ownerCols.includes(c);
        const socialFields = ['social_instagram','social_tiktok','social_youtube','social_facebook','social_spotify','social_website'];
        const includeSocials = socialFields.filter(c => ownerHas(c));

        const socialColsSql   = includeSocials.length ? ', ' + includeSocials.join(', ') : '';
        const socialPlacesSql = includeSocials.length ? ', ' + includeSocials.map(c => '@' + c).join(', ') : '';

        const ins = db.prepare(`
          INSERT INTO owner_profiles (
            slug, display_name, email, location,
            public_video_url, embed_video_url,
            short_quote, testimony_summary,
            status,
            format, written_body, audio_url, photo_url, photo_caption${socialColsSql},
            created_at, updated_at
          ) VALUES (
            @slug, @display_name, @email, @location,
            @public_video_url, @embed_video_url,
            @short_quote, @testimony_summary,
            'active',
            @format, @written_body, @audio_url, @photo_url, @photo_caption${socialPlacesSql},
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `).run({
          slug,
          display_name,
          // owner_profiles.email has a UNIQUE constraint and is only meant for the
          // legacy founder seed. Never copy the submitter's contact email here, or
          // two submissions from the same address (or two NULLs on some SQLite
          // builds) will collide on approve. Submitter email stays on
          // testimony_intake.contact_email so decision emails still fire.
          email: null,
          location,
          public_video_url,
          embed_video_url,
          short_quote,
          testimony_summary: sub.written_body || sub.photo_caption || null,
          format: fmt,
          written_body: sub.written_body || null,
          audio_url:    sub.audio_url    || null,
          photo_url:    sub.photo_url    || null,
          photo_caption: sub.photo_caption || null,
          // Opt-in social links copied from intake. NULL if submitter left blank.
          social_instagram: sub.social_instagram || null,
          social_tiktok:    sub.social_tiktok    || null,
          social_youtube:   sub.social_youtube   || null,
          social_facebook:  sub.social_facebook  || null,
          social_spotify:   sub.social_spotify   || null,
          social_website:   sub.social_website   || null,
        });
        ownerId = Number(ins.lastInsertRowid);
      } else {
        db.prepare(`UPDATE owner_profiles SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id = ?`).run(ownerId);
      }

      const upsert = db.prepare(`
        INSERT INTO testimony_item_codes (item_code, destination_mode, owner_profile_id, updated_at)
        VALUES (?, 'owner_profile', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(item_code) DO UPDATE SET
          destination_mode = 'owner_profile',
          owner_profile_id = excluded.owner_profile_id,
          updated_at = CURRENT_TIMESTAMP
      `);
      for (const code of cleanCodes) upsert.run(code, ownerId);

      db.prepare(`
        UPDATE testimony_intake
        SET status = 'approved',
            approved_owner_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(ownerId, sub.id);

      return { ownerId, attached: cleanCodes.length };
    });

    const out = tx();

    // Fire the approval email (with shareable URL + QR PNG attachments) fire-and-forget
    try {
      const freshIntake = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(sub.id);
      fireDecisionEmail(db, freshIntake, 'approved', out.ownerId);
    } catch (mailErr) {
      console.warn('[admin-testimony] approval mail kickoff failed:', mailErr.message);
    }

    res.json({ ok: true, owner_profile_id: out.ownerId, codes_attached: out.attached });
  } catch (e) {
    console.error('approve error:', e);
    res.status(500).json({ error: e.message || 'Approve failed' });
  }
});

/* ============================================================
 * WALL CLEANUP — archive owner_profiles rows so they fall off
 * the public wall (status changes to 'archived'; nothing is deleted).
 * ============================================================ */

// Archive all active wall records at once (cleans up duplicates/stale rows).
router.post('/wall/archive-all', (req, res) => {
  const db = getDb();
  try {
    const info = db.prepare(`
      UPDATE owner_profiles
      SET status = 'archived', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'active'
    `).run();
    res.json({ ok: true, archived: info.changes });
  } catch (e) {
    console.error('wall archive-all error:', e);
    res.status(500).json({ error: e.message || 'archive-all failed' });
  }
});

// Archive a single wall record by owner_profile id.
router.post('/wall/:id(\\d+)/archive', (req, res) => {
  const db = getDb();
  try {
    const info = db.prepare(`
      UPDATE owner_profiles
      SET status = 'archived', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);
    res.json({ ok: true, archived: info.changes });
  } catch (e) {
    console.error('wall archive one error:', e);
    res.status(500).json({ error: e.message || 'archive failed' });
  }
});

// Restore a single wall record (sets it back to 'active').
router.post('/wall/:id(\\d+)/restore', (req, res) => {
  const db = getDb();
  try {
    const info = db.prepare(`
      UPDATE owner_profiles
      SET status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);
    res.json({ ok: true, restored: info.changes });
  } catch (e) {
    console.error('wall restore error:', e);
    res.status(500).json({ error: e.message || 'restore failed' });
  }
});

// Attach a QR code to an existing wall record (multi-shirt / multi-sticker support).
// Body: { code: 'JIMK-SHARE-0007', owner_profile_id: 12 }
// Allows one testimony to be reachable from many physical items.
router.post('/codes/attach', (req, res) => {
  try {
    const db = getDb();
    const body = req.body || {};
    const code = String(body.code || '').trim().toUpperCase();
    const ownerId = Number(body.owner_profile_id);
    if (!code) return res.status(400).json({ error: 'missing_code' });
    if (!Number.isFinite(ownerId) || ownerId <= 0) return res.status(400).json({ error: 'missing_owner_profile_id' });

    const owner = db.prepare('SELECT id, slug, display_name FROM owner_profiles WHERE id = ?').get(ownerId);
    if (!owner) return res.status(404).json({ error: 'owner_profile_not_found' });

    const existing = db.prepare('SELECT item_code, owner_profile_id FROM testimony_item_codes WHERE item_code = ?').get(code);

    if (existing && existing.owner_profile_id && existing.owner_profile_id !== ownerId) {
      // Block reassignment unless caller passes force=true
      if (!body.force) {
        return res.status(409).json({
          error: 'code_already_linked',
          existing_owner_profile_id: existing.owner_profile_id,
          hint: 'Pass force:true to move this code to a different testimony.'
        });
      }
    }

    if (existing) {
      db.prepare(`
        UPDATE testimony_item_codes
           SET owner_profile_id = ?,
               destination_mode = 'owner_profile',
               updated_at = datetime('now')
         WHERE item_code = ?
      `).run(ownerId, code);
    } else {
      db.prepare(`
        INSERT INTO testimony_item_codes (item_code, destination_mode, owner_profile_id, updated_at)
        VALUES (?, 'owner_profile', ?, datetime('now'))
      `).run(code, ownerId);
    }

    res.json({
      ok: true,
      code,
      owner_profile_id: ownerId,
      owner_slug: owner.slug,
      owner_display_name: owner.display_name,
      reassigned: !!(existing && existing.owner_profile_id && existing.owner_profile_id !== ownerId)
    });
  } catch (err) {
    console.error('[admin-testimony] attach code error:', err);
    res.status(500).json({ error: 'attach_failed', message: err.message });
  }
});

// Detach a QR code (admin override).
router.post('/codes/detach', (req, res) => {
  try {
    const db = getDb();
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'missing_code' });
    const r = db.prepare(`
      UPDATE testimony_item_codes
         SET owner_profile_id = NULL,
             updated_at = datetime('now')
       WHERE item_code = ?
    `).run(code);
    res.json({ ok: true, code, cleared: r.changes });
  } catch (err) {
    res.status(500).json({ error: 'detach_failed', message: err.message });
  }
});

// Browse all codes for the admin code-picker dropdown.
router.get('/codes', (req, res) => {
  try {
    const db = getDb();
    const status = String(req.query.status || 'all'); // all | unused | linked
    let rows;
    if (status === 'unused') {
      rows = db.prepare(`
        SELECT item_code, owner_profile_id
          FROM testimony_item_codes
         WHERE owner_profile_id IS NULL
         ORDER BY item_code
      `).all();
    } else if (status === 'linked') {
      rows = db.prepare(`
        SELECT c.item_code, c.owner_profile_id, o.display_name AS owner_display_name, o.slug AS owner_slug
          FROM testimony_item_codes c
          LEFT JOIN owner_profiles o ON o.id = c.owner_profile_id
         WHERE c.owner_profile_id IS NOT NULL
         ORDER BY c.item_code
      `).all();
    } else {
      rows = db.prepare(`
        SELECT c.item_code, c.owner_profile_id, o.display_name AS owner_display_name, o.slug AS owner_slug
          FROM testimony_item_codes c
          LEFT JOIN owner_profiles o ON o.id = c.owner_profile_id
         ORDER BY c.item_code
      `).all();
    }
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: 'list_codes_failed', message: err.message });
  }
});

// Browse wall records (for the "attach to existing testimony" dropdown).
router.get('/owners', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, slug, display_name, location, format
        FROM owner_profiles
       WHERE status = 'active'
       ORDER BY display_name
    `).all();
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: 'list_owners_failed', message: err.message });
  }
});

module.exports = router;
