// routes/admin-testimony.js
// Admin moderation for multi-format testimony submissions.
// Mount at: app.use('/api/admin/testimony-submissions', adminAuth, require('./routes/admin-testimony'));

const express = require('express');
const router = express.Router();

// GET list (optionally filtered by status)
router.get('/', (req, res) => {
  const db = req.app.get('db');
  const status = req.query.status || 'pending';
  const rows = db.prepare(`
    SELECT * FROM testimony_submissions
    WHERE status = ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(status);
  res.json({ items: rows });
});

// GET one
router.get('/:id', (req, res) => {
  const db = req.app.get('db');
  const row = db.prepare('SELECT * FROM testimony_submissions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ item: row });
});

// PATCH update notes / short_quote / status (reject/archive)
router.patch('/:id', (req, res) => {
  const db = req.app.get('db');
  const { admin_notes, short_quote, status } = req.body || {};
  const allowed = ['pending','approved','rejected','archived'];
  const fields = [];
  const vals = [];
  if (admin_notes !== undefined) { fields.push('admin_notes = ?'); vals.push(String(admin_notes || '').slice(0, 2000)); }
  if (short_quote !== undefined) { fields.push('short_quote = ?'); vals.push(String(short_quote || '').slice(0, 200)); }
  if (status !== undefined) {
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Bad status' });
    fields.push('status = ?'); vals.push(status);
  }
  if (!fields.length) return res.json({ ok: true });
  fields.push(`updated_at = datetime('now')`);
  vals.push(req.params.id);
  db.prepare(`UPDATE testimony_submissions SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

/**
 * POST /:id/approve
 * Body:
 *   {
 *     display_name?, location?, short_quote?,
 *     item_codes: ["JIMK-SHARE-XXXX", ...],   // QR codes to attach to this testimony
 *     reuse_owner_id?: number                  // attach codes to an existing owner instead of creating new
 *   }
 *
 * Effect:
 *   - If reuse_owner_id provided: only attach selected QR codes to that owner's profile.
 *   - Otherwise: creates a new owner_profile from the submission, copying the appropriate
 *     format fields, then attaches selected QR codes (destination_mode='owner_profile').
 */
router.post('/:id/approve', (req, res) => {
  const db = req.app.get('db');
  const sub = db.prepare('SELECT * FROM testimony_submissions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (sub.status === 'approved') return res.status(400).json({ error: 'Already approved' });

  const body = req.body || {};
  const item_codes = Array.isArray(body.item_codes) ? body.item_codes : [];
  const cleanCodes = Array.from(new Set(
    item_codes.map(c => String(c || '').trim().toUpperCase()).filter(Boolean)
  ));

  const tx = db.transaction(() => {
    let ownerId = body.reuse_owner_id ? Number(body.reuse_owner_id) : null;

    if (!ownerId) {
      const display_name = String(body.display_name || sub.display_name || '').trim();
      const location     = String(body.location     || sub.location     || '').trim() || null;
      const short_quote  = String(body.short_quote  || sub.short_quote  || '').trim() || null;

      // Pick the right video field for owner_profile
      const public_video_url = sub.video_link_url || sub.video_file_url || null;

      const ins = db.prepare(`
        INSERT INTO owner_profiles (
          display_name, location, short_quote,
          public_video_url,
          format, written_body, audio_url, photo_url, photo_caption,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?,
          ?,
          ?, ?, ?, ?, ?,
          datetime('now'), datetime('now')
        )
      `).run(
        display_name, location, short_quote,
        public_video_url,
        sub.format, sub.written_body, sub.audio_url, sub.photo_url, sub.photo_caption
      );
      ownerId = Number(ins.lastInsertRowid);
    }

    // Attach selected QR codes to the owner
    const upsertCode = db.prepare(`
      INSERT INTO testimony_item_codes (item_code, destination_mode, owner_profile_id, updated_at)
      VALUES (?, 'owner_profile', ?, datetime('now'))
      ON CONFLICT(item_code) DO UPDATE SET
        destination_mode = 'owner_profile',
        owner_profile_id = excluded.owner_profile_id,
        updated_at = datetime('now')
    `);
    for (const code of cleanCodes) upsertCode.run(code, ownerId);

    db.prepare(`
      UPDATE testimony_submissions
      SET status = 'approved', approved_owner_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(ownerId, sub.id);

    return { ownerId, attached: cleanCodes.length };
  });

  try {
    const out = tx();
    res.json({ ok: true, owner_profile_id: out.ownerId, codes_attached: out.attached });
  } catch (e) {
    console.error('approve error:', e);
    res.status(500).json({ error: 'Approve failed' });
  }
});

module.exports = router;
