// routes/admin-testimony.js
// Admin moderation for multi-format testimony submissions stored in testimony_intake.

const express = require('express');
const { getDb } = require('../db/client');
const router = express.Router();

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

router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ item: row });
});

router.patch('/:id', (req, res) => {
  const db = getDb();
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
  db.prepare(`UPDATE testimony_intake SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

/**
 * POST /:id/approve
 * Currently only flips status to 'approved' on the intake row.
 * Wall publishing will be wired up once we confirm the actual wall table name.
 */
router.post('/:id/approve', (req, res) => {
  const db = getDb();
  const sub = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (sub.status === 'approved') return res.status(400).json({ error: 'Already approved' });

  try {
    db.prepare(`
      UPDATE testimony_intake
      SET status = 'approved', updated_at = datetime('now')
      WHERE id = ?
    `).run(sub.id);
    res.json({ ok: true, note: 'Marked approved. Wall publishing will be enabled once the wall table is confirmed.' });
  } catch (e) {
    console.error('approve error:', e);
    res.status(500).json({ error: 'Approve failed' });
  }
});

module.exports = router;
