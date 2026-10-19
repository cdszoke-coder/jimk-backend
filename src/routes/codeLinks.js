'use strict';
// -----------------------------------------------------------------------------
// codeLinks.js — "Link this shirt to my existing testimony", done properly.
//
// Replaces the old claim flow, which saved the request like a brand-new
// testimony (so approving it put an empty "pending" card on the wall and never
// linked the shirt). Here a link request is its own record, and approving it
// writes the new shirt code straight onto the existing testimony.
//
// PUBLIC
//   POST /api/public/testimony/claim        new shirt -> existing testimony (request)
//   GET  /api/public/code-links/find?name=  "Find my testimony" helper
//
// ADMIN  (header x-admin-key = ADMIN_API_KEY, same key as the rest of admin)
//   GET  /api/admin/code-claims?status=pending|approved|denied|all
//   POST /api/admin/code-claims/:id/approve
//   POST /api/admin/code-claims/:id/deny
//   GET  /api/admin/code-links/owners       every testimony + its codes
//   POST /api/admin/code-links/attach       { codes, owner_slug | owner_id | submission_id, force }
//
// Codes can be typed as just the number: "7", "0007", "jimk-share-7" and
// "JIMK-SHARE-0007" all mean JIMK-SHARE-0007.
//
// WIRE-UP (server.js), BEFORE the other /api/public routes so this /claim wins:
//   const codeLinksRoute = safeRequireRouter('./routes/codeLinks');
//   if (codeLinksRoute) app.use('/api', codeLinksRoute);
// -----------------------------------------------------------------------------

const express = require('express');
const { getDb } = require('../db/client');

let notify = null;
try { notify = require('../lib/notifyOwner'); } catch (_) { notify = null; }

const router = express.Router();
router.use(express.json({ limit: '64kb' }));

// ---------- codes ----------
function normalizeCode(raw) {
  if (raw === undefined || raw === null) return '';
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  const m = s.match(/[?&](?:SHIRT|CODE|QR)=([^&]+)/i);           // a pasted link
  if (m) { try { s = decodeURIComponent(m[1]).toUpperCase(); } catch (_) { s = m[1]; } }
  const share = s.match(/^(?:JIMK[-_]?(?:SHARE)?[-_]?)?#?0*(\d{1,6})$/);
  if (share) return 'JIMK-SHARE-' + share[1].padStart(4, '0');
  return s.replace(/[^A-Z0-9._-]/g, '').slice(0, 60);
}
function splitCodes(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[,\s;]+/);
  return Array.from(new Set(list.map(normalizeCode).filter(Boolean)));
}
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ---------- schema discovery (works with the existing tables as they are) ----------
let schemaCache = null;
function schema() {
  if (schemaCache) return schemaCache;
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const cols = (t) => db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all();
  const info = {};
  for (const t of tables) info[t] = cols(t);
  const has = (t, c) => (info[t] || []).some(x => x.name === c);

  const owners = process.env.OWNERS_TABLE || (tables.includes('owner_profiles') ? 'owner_profiles' : null);
  const codes = process.env.CODES_TABLE || (tables.includes('testimony_item_codes') ? 'testimony_item_codes' : null);
  const intake = process.env.INTAKE_TABLE ||
    tables.find(t => has(t, 'approved_owner_id') && has(t, 'display_name')) ||
    tables.find(t => /intake|submission/i.test(t) && has(t, 'display_name')) || null;

  schemaCache = { tables, info, has, owners, codes, intake };
  return schemaCache;
}

function ensureClaimsTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS code_link_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      new_code TEXT NOT NULL,
      old_code TEXT,
      owner_profile_id INTEGER,
      owner_slug TEXT,
      owner_name TEXT,
      submitted_name TEXT,
      contact_email TEXT,
      name_matches INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_code_link_requests_status ON code_link_requests(status);
  `);
}

// ---------- lookups ----------
function ownerById(id) {
  const s = schema(); if (!s.owners || id === undefined || id === null || id === '') return null;
  return getDb().prepare(`SELECT * FROM "${s.owners}" WHERE id = ?`).get(Number(id)) || null;
}
function ownerBySlug(slug) {
  const s = schema(); if (!s.owners || !slug) return null;
  return getDb().prepare(`SELECT * FROM "${s.owners}" WHERE lower(slug) = lower(?)`).get(String(slug).trim()) || null;
}
function codeRow(code) {
  const s = schema(); if (!s.codes) return null;
  return getDb().prepare(`SELECT * FROM "${s.codes}" WHERE upper(item_code) = upper(?)`).get(code) || null;
}
function ownerByCode(code) {
  const row = codeRow(code);
  return row && row.owner_profile_id ? ownerById(row.owner_profile_id) : null;
}
function codesForOwner(ownerId) {
  const s = schema(); if (!s.codes) return [];
  return getDb().prepare(`SELECT item_code FROM "${s.codes}" WHERE owner_profile_id = ? ORDER BY item_code`)
    .all(Number(ownerId)).map(r => r.item_code);
}
function ownerForSubmission(subId) {
  const s = schema(); if (!s.intake) return null;
  const sub = getDb().prepare(`SELECT * FROM "${s.intake}" WHERE id = ?`).get(Number(subId));
  if (!sub) return null;
  for (const c of ['approved_owner_id', 'owner_profile_id', 'linked_owner_profile_id']) {
    if (sub[c]) { const o = ownerById(sub[c]); if (o) return o; }
  }
  // Older rows never stored the owner id: match on name (+ location if possible).
  if (!s.owners || !sub.display_name) return null;
  const all = getDb().prepare(`SELECT * FROM "${s.owners}"`).all();
  const name = norm(sub.display_name), loc = norm(sub.location);
  const byBoth = all.filter(o => norm(o.display_name) === name && (!loc || norm(o.location) === loc));
  if (byBoth.length === 1) return byBoth[0];
  const byName = all.filter(o => norm(o.display_name) === name);
  return byName.length === 1 ? byName[0] : null;
}

// Status value existing linked codes already use (so we write the same word).
function linkedStatusWord() {
  const s = schema();
  if (!s.codes || !s.has(s.codes, 'status')) return null;
  const r = getDb().prepare(`SELECT status, COUNT(*) n FROM "${s.codes}" WHERE owner_profile_id IS NOT NULL AND status IS NOT NULL GROUP BY status ORDER BY n DESC LIMIT 1`).get();
  return (r && r.status) || 'linked';
}

// ---------- the actual link ----------
function linkCode(code, ownerId, force) {
  const s = schema();
  if (!s.codes) throw Object.assign(new Error('Code table not found (set CODES_TABLE on Render).'), { status: 500 });
  const owner = ownerById(ownerId);
  if (!owner) throw Object.assign(new Error('Testimony not found.'), { status: 404 });

  const db = getDb();
  const existing = codeRow(code);
  if (existing && existing.owner_profile_id && Number(existing.owner_profile_id) === Number(owner.id)) {
    return { code, status: 'already_linked', owner_slug: owner.slug };
  }
  if (existing && existing.owner_profile_id && !force) {
    const other = ownerById(existing.owner_profile_id);
    const err = new Error(`${code} is already linked to ${other ? other.display_name : 'another testimony'}.`);
    err.status = 409; err.hint = 'Tick "Force" to move it.'; throw err;
  }

  const cols = s.info[s.codes].map(c => c.name);
  const statusWord = linkedStatusWord();
  const nowCols = ['updated_at', 'linked_at', 'assigned_at', 'claimed_at'].filter(c => cols.includes(c));

  if (existing) {
    const sets = ['owner_profile_id = @owner'];
    if (statusWord && cols.includes('status')) sets.push('status = @status');
    nowCols.forEach(c => sets.push(`${c} = datetime('now')`));
    db.prepare(`UPDATE "${s.codes}" SET ${sets.join(', ')} WHERE id = @id`)
      .run({ owner: owner.id, status: statusWord, id: existing.id });
    return { code, status: existing.owner_profile_id ? 'reassigned' : 'linked', owner_slug: owner.slug };
  }

  // New row: fill item_code + owner, plus any NOT NULL column that has no default.
  const values = { item_code: code, owner_profile_id: owner.id };
  if (cols.includes('status') && statusWord) values.status = statusWord;
  const nowSql = {};
  for (const c of s.info[s.codes]) {
    if (c.pk || values[c.name] !== undefined) continue;
    if (/(_at|_on|date)$/i.test(c.name)) { nowSql[c.name] = true; continue; }
    if (c.notnull && c.dflt_value === null) {
      if (/type|kind/i.test(c.name)) values[c.name] = 'shirt';
      else if (/source/i.test(c.name)) values[c.name] = 'admin_link';
      else throw Object.assign(new Error(`Cannot create code row: column "${c.name}" is required.`), { status: 500 });
    }
  }
  const names = Object.keys(values).concat(Object.keys(nowSql));
  const params = Object.keys(values).map(k => '@' + k).concat(Object.keys(nowSql).map(() => "datetime('now')"));
  db.prepare(`INSERT INTO "${s.codes}" (${names.map(n => `"${n}"`).join(', ')}) VALUES (${params.join(', ')})`).run(values);
  return { code, status: 'linked', owner_slug: owner.slug };
}

// ---------- auth ----------
function adminAuth(req, res, next) {
  const key = req.get('x-admin-key') || req.query.admin_key || '';
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}
function fail(res, e) {
  const status = e.status || 500;
  if (status >= 500) console.error('[codeLinks]', e.message);
  res.status(status).json({ ok: false, error: e.message || 'server error', hint: e.hint });
}
function publicOwner(o) {
  return o ? { id: o.id, slug: o.slug, name: o.display_name, location: o.location || '' } : null;
}

// =============================== PUBLIC ======================================

// Find-my-testimony: search by name, returns public wall info + the code NUMBERS
// (the same codes the public story page already lists).
router.get('/public/code-links/find', (req, res) => {
  try {
    const q = norm(req.query.name);
    if (q.length < 2) return res.json({ ok: true, items: [] });
    const s = schema(); if (!s.owners) return res.json({ ok: true, items: [] });
    const rows = getDb().prepare(`SELECT * FROM "${s.owners}"`).all()
      .filter(o => (!s.has(s.owners, 'status') || !o.status || o.status === 'active'))
      .filter(o => norm(o.display_name).includes(q))
      .slice(0, 8);
    res.json({
      ok: true,
      items: rows.map(o => ({
        slug: o.slug, name: o.display_name, location: o.location || '',
        quote: o.short_quote || '', format: o.format || '',
        codes: codesForOwner(o.id),
      })),
    });
  } catch (e) { fail(res, e); }
});

router.post('/public/testimony/claim', (req, res) => {
  try {
    ensureClaimsTable();
    const b = req.body || {};
    const newCode = normalizeCode(b.new_qr_code || b.new_code);
    const oldCode = normalizeCode(b.old_qr_code || b.old_code);
    const slug = String(b.owner_slug || '').trim();
    const name = String(b.display_name || '').trim().slice(0, 120);
    const email = String(b.contact_email || '').trim().slice(0, 200);

    if (!newCode) return res.status(400).json({ ok: false, error: 'Enter the number from your NEW shirt (or scan its QR code).' });
    if (!oldCode && !slug) return res.status(400).json({ ok: false, error: 'Enter the number from your FIRST shirt, or use "Find my testimony".' });
    if (oldCode && oldCode === newCode) return res.status(400).json({ ok: false, error: 'That is the same code twice. Enter your first shirt\'s number in the second box.' });

    const owner = slug ? ownerBySlug(slug) : ownerByCode(oldCode);
    if (!owner) {
      return res.status(404).json({ ok: false, error: `We couldn't find a testimony for ${oldCode || 'that choice'}. Check the number, or use "Find my testimony".` });
    }

    // New shirt already linked?
    const taken = ownerByCode(newCode);
    if (taken && Number(taken.id) === Number(owner.id)) {
      return res.json({ ok: true, matched: true, already: true, owner: publicOwner(owner),
        message: `Good news: ${newCode} is already linked to your testimony.` });
    }
    if (taken) {
      return res.status(409).json({ ok: false, error: `${newCode} is already linked to a different testimony. Please contact us.` });
    }

    const db = getDb();
    const dupe = db.prepare(`SELECT id FROM code_link_requests WHERE new_code = ? AND owner_profile_id = ? AND status = 'pending'`).get(newCode, owner.id);
    const f1 = norm(owner.display_name).split(' ')[0], f2 = norm(name).split(' ')[0];
    const nameMatches = name ? ((f1 && f2 && (f1.startsWith(f2) || f2.startsWith(f1))) ? 1 : 0) : 0;
    let id = dupe && dupe.id;
    if (!id) {
      id = db.prepare(`INSERT INTO code_link_requests
        (new_code, old_code, owner_profile_id, owner_slug, owner_name, submitted_name, contact_email, name_matches)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newCode, oldCode || null, owner.id, owner.slug, owner.display_name, name, email, nameMatches).lastInsertRowid;

      if (notify && notify.notifyOwner) {
        notify.notifyOwner({
          headline: 'SHIRT LINK REQUEST',
          name: name || owner.display_name,
          kind: 'Link ' + newCode + ' to ' + owner.display_name + "'s testimony" + (nameMatches || !name ? '' : ' (NAME DIFFERS)'),
          submissionId: 'claim-' + id,
        }).catch(() => {});
      }
    }

    res.json({
      ok: true, matched: true, request_id: Number(id), owner: publicOwner(owner),
      message: `We found ${owner.display_name}'s testimony. Your new shirt (${newCode}) will be linked as soon as a moderator approves it.`,
    });
  } catch (e) { fail(res, e); }
});

// =============================== ADMIN =======================================

router.get('/admin/code-claims', adminAuth, (req, res) => {
  try {
    ensureClaimsTable();
    const st = String(req.query.status || 'pending');
    const rows = st === 'all'
      ? getDb().prepare(`SELECT * FROM code_link_requests ORDER BY id DESC LIMIT 200`).all()
      : getDb().prepare(`SELECT * FROM code_link_requests WHERE status = ? ORDER BY id DESC LIMIT 200`).all(st);
    rows.forEach(r => { r.current_codes = r.owner_profile_id ? codesForOwner(r.owner_profile_id) : []; });
    res.json({ ok: true, items: rows });
  } catch (e) { fail(res, e); }
});

router.post('/admin/code-claims/:id/approve', adminAuth, (req, res) => {
  try {
    ensureClaimsTable();
    const db = getDb();
    const r = db.prepare(`SELECT * FROM code_link_requests WHERE id = ?`).get(Number(req.params.id));
    if (!r) return res.status(404).json({ ok: false, error: 'Request not found.' });
    if (r.status !== 'pending') return res.json({ ok: true, status: r.status, note: 'Already ' + r.status + '.' });
    const result = linkCode(r.new_code, r.owner_profile_id, !!(req.body && req.body.force));
    db.prepare(`UPDATE code_link_requests SET status='approved', decided_at=datetime('now'), admin_note=? WHERE id=?`)
      .run(String((req.body && req.body.note) || ''), r.id);
    res.json({ ok: true, result, codes: codesForOwner(r.owner_profile_id),
      story_url: 'https://www.jesusismykingmovement.com/story.html?id=' + encodeURIComponent(r.owner_slug || '') });
  } catch (e) { fail(res, e); }
});

router.post('/admin/code-claims/:id/deny', adminAuth, (req, res) => {
  try {
    ensureClaimsTable();
    const info = getDb().prepare(`UPDATE code_link_requests SET status='denied', decided_at=datetime('now'), admin_note=? WHERE id=? AND status='pending'`)
      .run(String((req.body && req.body.note) || ''), Number(req.params.id));
    res.json({ ok: true, changed: info.changes });
  } catch (e) { fail(res, e); }
});

// A wall card with nothing to show (this is what the old claim flow created).
function isEmptyOwner(o) {
  const fields = ['public_video_url', 'embed_video_url', 'written_body', 'audio_url', 'photo_url', 'testimony_summary'];
  return !fields.some(f => o[f] && String(o[f]).trim());
}

router.get('/admin/code-links/owners', adminAuth, (req, res) => {
  try {
    const s = schema(); if (!s.owners) return res.json({ ok: true, items: [] });
    const rows = getDb().prepare(`SELECT * FROM "${s.owners}" ORDER BY display_name COLLATE NOCASE`).all();
    const fmtOf = (o) => o.format || (o.public_video_url || o.embed_video_url ? 'video' : o.audio_url ? 'audio' : o.photo_url ? 'photo' : o.written_body ? 'written' : '');
    res.json({ ok: true, can_hide: s.has(s.owners, 'status'), items: rows.map(o => ({
      id: o.id, slug: o.slug, display_name: o.display_name, location: o.location || '',
      status: o.status || 'active', format: fmtOf(o), empty: isEmptyOwner(o),
      quote: String(o.short_quote || o.written_body || o.testimony_summary || '').slice(0, 140),
      photo_url: o.photo_url || '',
      video_id: ((String(o.embed_video_url || o.public_video_url || '').match(/(?:embed\/|v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/) || [])[1] || ''),
      date: o.approved_at || o.created_at || o.updated_at || '',
      codes: codesForOwner(o.id),
    })) });
  } catch (e) { fail(res, e); }
});

// Hide / show a wall card (reversible). Used to clear the empty cards the old
// claim flow left behind. Sets owner status to 'hidden' or back to 'active'.
router.post('/admin/code-links/owner/:id/visibility', adminAuth, (req, res) => {
  try {
    const s = schema();
    if (!s.owners || !s.has(s.owners, 'status')) return res.status(400).json({ ok: false, error: 'Wall table has no status column.' });
    const show = !!(req.body && req.body.show);
    const info = getDb().prepare(`UPDATE "${s.owners}" SET status = ? WHERE id = ?`).run(show ? 'active' : 'hidden', Number(req.params.id));
    res.json({ ok: info.changes === 1, status: show ? 'active' : 'hidden' });
  } catch (e) { fail(res, e); }
});

router.post('/admin/code-links/attach', adminAuth, (req, res) => {
  try {
    const b = req.body || {};
    const codes = splitCodes(b.codes || b.code);
    if (!codes.length) return res.status(400).json({ ok: false, error: 'Enter at least one code number.' });
    let owner = null;
    if (b.owner_id) owner = ownerById(b.owner_id);
    if (!owner && b.owner_slug) owner = ownerBySlug(b.owner_slug);
    if (!owner && b.submission_id) owner = ownerForSubmission(b.submission_id);
    if (!owner) {
      return res.status(404).json({ ok: false, error: 'Could not find this testimony on the wall. Approve it first, or pick it in "Link a shirt code".' });
    }
    const results = codes.map(code => {
      try { return Object.assign({ ok: true }, linkCode(code, owner.id, !!b.force)); }
      catch (e) { return { ok: false, code, error: e.message, hint: e.hint }; }
    });
    res.json({ ok: results.every(r => r.ok), owner: publicOwner(owner), results, codes: codesForOwner(owner.id) });
  } catch (e) { fail(res, e); }
});

router.get('/admin/code-links/debug', adminAuth, (req, res) => {
  try {
    schemaCache = null;
    const s = schema();
    res.json({ owners_table: s.owners, codes_table: s.codes, intake_table: s.intake,
      codes_columns: s.codes ? s.info[s.codes] : null, linked_status_word: linkedStatusWord(), tables: s.tables });
  } catch (e) { fail(res, e); }
});

router._normalizeCode = normalizeCode;   // for tests
module.exports = router;
