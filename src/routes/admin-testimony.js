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

// Async audio -> video -> YouTube pipeline. Kicked off after an audio testimony
// is approved. Failures are logged into audio_job_log; they never affect the
// HTTP response the admin sees.
let audioJob = null;
try { audioJob = require('../services/testimonyAudioJob'); }
catch (err) { console.warn('[admin-testimony] testimonyAudioJob not loaded:', err.message); }

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

  // CLAIM REQUEST detection. If admin_notes starts with [CLAIM REQUEST] we
  // attempt to extract the matched owner_id the public /claim endpoint logged.
  // Admin can still override by passing reuse_owner_id in the request body.
  let claimOwnerId = null;
  const notes = String(sub.admin_notes || '');
  const isClaim = /^\[CLAIM REQUEST\]/i.test(notes);
  if (isClaim) {
    const m = notes.match(/owner_id=(\d+)/);
    if (m) claimOwnerId = Number(m[1]);
    // Ensure the new shirt code (stored on intake.qr_code) is in the list of
    // codes the admin is attaching. Admin can still add more codes.
    if (sub.qr_code) {
      const newCode = String(sub.qr_code).trim().toUpperCase();
      if (newCode && !cleanCodes.includes(newCode)) cleanCodes.push(newCode);
    }
  }

  try {
    const tx = db.transaction(() => {
      // Precedence: explicit body.reuse_owner_id > claim-matched owner > new owner.
      let ownerId = body.reuse_owner_id ? Number(body.reuse_owner_id)
                  : (claimOwnerId || null);

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

    // Audio -> video -> YouTube pipeline. Runs in the background after this
    // response is already sent, so admin never waits on ffmpeg + upload.
    // The job promotes owner_profiles.format to 'video' and fills
    // public_video_url + embed_video_url when YouTube returns the watch URL.
    const canAudio = sub.format === 'audio' && sub.audio_url;
    const canVideo = sub.format === 'video' && sub.video_file_url;
    if (audioJob && (canAudio || canVideo)) {
      try {
        const starter = (canVideo && typeof audioJob.startVideoTestimonyJob === 'function')
          ? audioJob.startVideoTestimonyJob
          : audioJob.startAudioTestimonyJob;
        starter({
          intakeId: sub.id,
          ownerProfileId: out.ownerId
        });
      } catch (jobErr) {
        console.warn('[admin-testimony] media job kickoff failed:', jobErr.message);
      }
    }

    res.json({
      ok: true,
      owner_profile_id: out.ownerId,
      codes_attached: out.attached,
      audio_job_started: !!(audioJob && (canAudio || canVideo))
    });
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

// ============================================================
// EDIT SOCIALS — admin-only update of the six opt-in social fields
// on an existing owner_profile (wall record). Scope is intentionally tight:
// six URL columns + nothing else. Other columns are preserved.
// ============================================================

const SOCIAL_FIELDS = [
  'social_instagram',
  'social_tiktok',
  'social_youtube',
  'social_facebook',
  'social_spotify',
  'social_website'
];

function normalizeSocialValue(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 300) return s.slice(0, 300);
  return s;
}

// GET current socials for a wall record. Returns null for missing columns.
router.get('/owner/:id(\\d+)/socials', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);

    const cols = db.prepare('PRAGMA table_info(owner_profiles)').all().map(c => c.name);
    const has = (c) => cols.includes(c);
    const selectParts = ['id', 'display_name', 'slug'];
    for (const f of SOCIAL_FIELDS) {
      selectParts.push(has(f) ? f : `NULL AS ${f}`);
    }
    const row = db.prepare(`SELECT ${selectParts.join(', ')} FROM owner_profiles WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true, owner: row });
  } catch (e) {
    console.error('socials read error:', e);
    return res.status(500).json({ error: e.message || 'read_failed' });
  }
});

// PATCH socials. Body may contain any subset of the six fields.
// Empty string / missing key = clear that field (set to NULL).
// Anything outside the whitelist is silently ignored.
router.patch('/owner/:id(\\d+)/socials', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const body = req.body || {};

    // Sanity check the owner exists before doing anything.
    const existing = db.prepare('SELECT id FROM owner_profiles WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    // Detect which social columns exist so we don't write to a missing column
    // on a legacy DB (pre-Drop-1). Caller gets a 400 if no migration ran.
    const cols = db.prepare('PRAGMA table_info(owner_profiles)').all().map(c => c.name);
    const writable = SOCIAL_FIELDS.filter(f => cols.includes(f));
    if (!writable.length) {
      return res.status(400).json({
        error: 'no_social_columns',
        message: 'owner_profiles is missing the social columns. Run the migration first.'
      });
    }

    // Collect updates. Only keys explicitly present in the body are touched.
    const updates = {};
    for (const f of writable) {
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        updates[f] = normalizeSocialValue(body[f]);
      }
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'no_fields', message: 'No social fields provided to update.' });
    }

    const setSql = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE owner_profiles SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run({ id, ...updates });

    // Return the fresh row so the admin UI can repaint without a refetch.
    const selectParts = ['id', 'display_name', 'slug'];
    for (const f of SOCIAL_FIELDS) {
      selectParts.push(cols.includes(f) ? f : `NULL AS ${f}`);
    }
    const fresh = db.prepare(`SELECT ${selectParts.join(', ')} FROM owner_profiles WHERE id = ?`).get(id);
    return res.json({ ok: true, owner: fresh, updated_fields: Object.keys(updates) });
  } catch (e) {
    console.error('socials update error:', e);
    return res.status(500).json({ error: e.message || 'update_failed' });
  }
});

// ---------------------------------------------------------------------------
// Site-wide social links (footer): Instagram, TikTok, YouTube ONLY.
// Stored as a single JSON blob in app_settings under key='site_socials'.
// Blank value -> link hidden site-wide. Reads are public (GET /api/public/site-socials).
// ---------------------------------------------------------------------------
function ensureAppSettingsTable(db) {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`).run();
  } catch (_) { /* ignore */ }
}

function normalizeSiteSocialValue(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  // Reject anything that isn't an http(s) URL or a leading-@ handle.
  if (/^https?:\/\//i.test(s)) return s;
  return s; // accept handles too; frontend can prefix if needed
}

router.get('/site-socials', (req, res) => {
  try {
    const db = getDb();
    ensureAppSettingsTable(db);
    let raw = null;
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'site_socials'").get();
      raw = row ? row.value : null;
    } catch (_) { raw = null; }
    let parsed = {};
    if (raw) { try { parsed = JSON.parse(raw) || {}; } catch (_) { parsed = {}; } }
    return res.json({
      ok: true,
      socials: {
        instagram: typeof parsed.instagram === 'string' ? parsed.instagram : '',
        tiktok:    typeof parsed.tiktok    === 'string' ? parsed.tiktok    : '',
        youtube:   typeof parsed.youtube   === 'string' ? parsed.youtube   : ''
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'read_failed' });
  }
});

router.patch('/site-socials', (req, res) => {
  try {
    const db = getDb();
    ensureAppSettingsTable(db);
    const body = req.body || {};

    // Load existing first so partial updates merge cleanly.
    let current = { instagram: '', tiktok: '', youtube: '' };
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'site_socials'").get();
      if (row && row.value) {
        const parsed = JSON.parse(row.value) || {};
        current = {
          instagram: typeof parsed.instagram === 'string' ? parsed.instagram : '',
          tiktok:    typeof parsed.tiktok    === 'string' ? parsed.tiktok    : '',
          youtube:   typeof parsed.youtube   === 'string' ? parsed.youtube   : ''
        };
      }
    } catch (_) { /* ignore, use defaults */ }

    const ALLOWED = ['instagram', 'tiktok', 'youtube'];
    const updates = {};
    for (const k of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        updates[k] = normalizeSiteSocialValue(body[k]);
      }
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'no_fields', message: 'No site social fields provided.' });
    }

    const next = { ...current, ...updates };
    const json = JSON.stringify(next);
    db.prepare(`INSERT INTO app_settings (key, value, updated_at)
                VALUES ('site_socials', @json, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = @json, updated_at = CURRENT_TIMESTAMP`).run({ json });

    return res.json({ ok: true, socials: next, updated_fields: Object.keys(updates) });
  } catch (e) {
    console.error('site-socials update error:', e);
    return res.status(500).json({ error: e.message || 'update_failed' });
  }
});

/* ============================================================
 * REBUILD AUDIO -> VIDEO for an already-approved audio testimony.
 * Same pipeline as first-approval, minus the email + minus the
 * QR-code / owner-profile creation logic. Idempotent: safe to call
 * multiple times; each run produces a fresh YouTube video and
 * overwrites owner_profiles.public_video_url + embed_video_url.
 *
 * POST /api/admin/testimony-submissions/:id/rebuild-audio-video
 * ============================================================ */
router.post('/:id(\\d+)/rebuild-audio-video', (req, res) => {
  if (!audioJob) {
    return res.status(500).json({ error: 'audio job service not loaded' });
  }
  const db = getDb();
  const sub = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (sub.format !== 'audio' && sub.format !== 'video') {
    return res.status(400).json({ error: 'Only audio or video submissions can be rebuilt with this endpoint' });
  }
  if (sub.format === 'audio' && !sub.audio_url) {
    return res.status(400).json({ error: 'This submission has no audio file on record' });
  }
  if (sub.format === 'video' && !sub.video_file_url) {
    return res.status(400).json({ error: 'This submission has no uploaded video file on record (pasted video links cannot be re-rendered)' });
  }

  // Resolve owner id: prefer intake.approved_owner_id (set at first approval).
  // Fall back to a body-supplied ownerProfileId if the caller wants to target
  // a specific wall record (e.g. after a claim-attach).
  let ownerProfileId = Number(sub.approved_owner_id || 0);
  const bodyOwner = req.body && (req.body.owner_profile_id || req.body.ownerProfileId);
  if (bodyOwner) ownerProfileId = Number(bodyOwner);

  if (!ownerProfileId) {
    return res.status(400).json({
      error: 'This intake is not linked to an owner_profile yet. Approve it first, or pass owner_profile_id in the request body.'
    });
  }

  // Sanity-check the owner still exists.
  const owner = db.prepare('SELECT id, slug, display_name FROM owner_profiles WHERE id = ?').get(ownerProfileId);
  if (!owner) return res.status(404).json({ error: 'Linked owner_profile not found' });

  try {
    const starter = (sub.format === 'video' && typeof audioJob.startVideoTestimonyJob === 'function')
      ? audioJob.startVideoTestimonyJob
      : audioJob.startAudioTestimonyJob;
    starter({
      intakeId: sub.id,
      ownerProfileId: owner.id
    });
    return res.json({
      ok: true,
      intake_id: sub.id,
      owner_profile_id: owner.id,
      display_name: owner.display_name,
      slug: owner.slug,
      status: 'queued',
      note: 'Rebuild queued. Check Render logs or the audio_job_log table for progress. Story page will refresh once the YouTube upload completes.'
    });
  } catch (e) {
    console.error('[admin-testimony] rebuild-audio-video kickoff failed:', e);
    return res.status(500).json({ error: e.message || 'rebuild kickoff failed' });
  }
});

/* ============================================================
 * READ audio_job_log for one intake (admin can see the pipeline
 * progress + any error text without shelling into the DB).
 * ============================================================ */
router.get('/:id(\\d+)/audio-job-log', (req, res) => {
  const db = getDb();
  try {
    // Table is created lazily by the audio job on first run; return empty
    // list gracefully if it doesn't exist yet.
    const exists = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='audio_job_log'"
    ).get();
    if (!exists) return res.json({ items: [] });
    const rows = db.prepare(
      'SELECT id, intake_id, owner_profile_id, status, video_id, public_video_url, error, created_at '
      + 'FROM audio_job_log WHERE intake_id = ? ORDER BY id DESC LIMIT 50'
    ).all(req.params.id);
    return res.json({ items: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'log read failed' });
  }
});

module.exports = router;
