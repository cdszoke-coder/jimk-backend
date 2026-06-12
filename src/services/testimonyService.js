const { nanoid } = require('nanoid');

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function normalizeItemCodes(input) {
  const list = Array.isArray(input) ? input : [input];
  return [...new Set(list.map(code => String(code || '').trim().toUpperCase()).filter(Boolean))];
}

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value ?? ''));
}

function logAudit(db, action, entityType, entityId, payload = {}) {
  db.prepare(`
    INSERT INTO admin_audit_logs (action, entity_type, entity_id, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(action, entityType, String(entityId), JSON.stringify(payload));
}

function getFounderPayload(db) {
  return {
    mode: 'default_founder',
    display_name: getSetting(db, 'founder_display_name', 'Founder, Jesus Is My King Movement'),
    public_video_url: getSetting(db, 'founder_public_video_url', ''),
    embed_video_url: getSetting(db, 'founder_embed_video_url', ''),
    short_quote: getSetting(db, 'founder_short_quote', ''),
    testimony_summary: getSetting(db, 'founder_testimony_summary', ''),
    site_base_url: getSetting(db, 'site_base_url', null)
  };
}

function updateFounderPayload(db, payload = {}) {
  const current = getFounderPayload(db);
  const next = {
    ...current,
    display_name: payload.display_name ?? current.display_name,
    public_video_url: payload.public_video_url ?? current.public_video_url,
    embed_video_url: payload.embed_video_url ?? current.embed_video_url,
    short_quote: payload.short_quote ?? current.short_quote,
    testimony_summary: payload.testimony_summary ?? current.testimony_summary,
    site_base_url: payload.site_base_url ?? current.site_base_url
  };

  setSetting(db, 'founder_display_name', next.display_name);
  setSetting(db, 'founder_public_video_url', next.public_video_url);
  setSetting(db, 'founder_embed_video_url', next.embed_video_url);
  setSetting(db, 'founder_short_quote', next.short_quote);
  setSetting(db, 'founder_testimony_summary', next.testimony_summary);
  setSetting(db, 'site_base_url', next.site_base_url);

  logAudit(db, 'founder_settings_updated', 'site_settings', 'founder_defaults', next);
  return getFounderPayload(db);
}

function findOwnerByEmail(db, email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM owner_profiles WHERE lower(email) = lower(?) LIMIT 1').get(email);
}

function findOwnerById(db, ownerId) {
  return db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(ownerId);
}

function findOwnerBySlug(db, slug) {
  return db.prepare('SELECT * FROM owner_profiles WHERE slug = ?').get(slug);
}

function getOwnerWithItems(db, ownerId) {
  const owner = findOwnerById(db, ownerId);
  if (!owner) return null;
  const itemCodes = db.prepare(`
    SELECT item_code, destination_mode, claimed_at, first_scanned_at
    FROM testimony_item_codes
    WHERE owner_profile_id = ?
    ORDER BY item_code ASC
  `).all(ownerId);
  return {
    ...owner,
    linked_item_codes: itemCodes.map(row => row.item_code),
    item_code_details: itemCodes
  };
}

function ensureItemCodesExist(db, itemCodes) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO testimony_item_codes (item_code, destination_mode)
    VALUES (?, 'default_founder')
  `);
  const select = db.prepare('SELECT * FROM testimony_item_codes WHERE item_code = ?');

  return itemCodes.map(itemCode => {
    insert.run(itemCode);
    return select.get(itemCode);
  });
}

function buildPaginatedResult(items, total, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    items,
    total,
    page,
    page_size: pageSize,
    total_pages: totalPages,
    has_prev: page > 1,
    has_next: page < totalPages
  };
}

function getSubmissionCounts(db) {
  const rows = db.prepare(`
    SELECT review_status, COUNT(*) AS count
    FROM testimony_submissions
    GROUP BY review_status
  `).all();

  const counts = {
    all: 0,
    pending: 0,
    approved_new_owner: 0,
    merged_to_existing: 0,
    rejected: 0
  };

  rows.forEach(row => {
    counts[row.review_status] = row.count;
    counts.all += row.count;
  });

  return counts;
}

function listItemCodes(db, filters = {}) {
  const clauses = [];
  const values = [];

  if (filters.status === 'claimed') clauses.push("tic.destination_mode = 'owner_profile'");
  if (filters.status === 'default') clauses.push("tic.destination_mode = 'default_founder'");

  if (filters.query) {
    clauses.push('(tic.item_code LIKE ? OR IFNULL(op.display_name, "") LIKE ? OR IFNULL(op.slug, "") LIKE ?)');
    const q = `%${String(filters.query).trim()}%`;
    values.push(q, q, q);
  }

  const sql = `
    SELECT tic.*, op.slug AS owner_slug, op.display_name AS owner_display_name
    FROM testimony_item_codes tic
    LEFT JOIN owner_profiles op ON op.id = tic.owner_profile_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY tic.updated_at DESC, tic.item_code ASC
    LIMIT ? OFFSET ?
  `;
  const limit = Number(filters.limit || 200);
  const offset = Number(filters.offset || 0);
  values.push(limit, offset);
  return db.prepare(sql).all(...values);
}

function resolveItemCode(db, rawItemCode) {
  const itemCode = String(rawItemCode || '').trim().toUpperCase();
  const founder = getFounderPayload(db);

  if (!itemCode) {
    return { found: false, claimable: false, item_code: null, ...founder };
  }

  // Detect optional multi-format + social columns so the query works on either schema.
  const ownerCols = db.prepare('PRAGMA table_info(owner_profiles)').all().map(c => c.name);
  const hasCol = (c) => ownerCols.includes(c);
  const optionalSelects = [
    hasCol('format')           ? 'op.format'           : `'video' AS format`,
    hasCol('written_body')     ? 'op.written_body'     : 'NULL AS written_body',
    hasCol('audio_url')        ? 'op.audio_url'        : 'NULL AS audio_url',
    hasCol('photo_url')        ? 'op.photo_url'        : 'NULL AS photo_url',
    hasCol('photo_caption')    ? 'op.photo_caption'    : 'NULL AS photo_caption',
    hasCol('social_instagram') ? 'op.social_instagram' : 'NULL AS social_instagram',
    hasCol('social_tiktok')    ? 'op.social_tiktok'    : 'NULL AS social_tiktok',
    hasCol('social_youtube')   ? 'op.social_youtube'   : 'NULL AS social_youtube',
    hasCol('social_facebook')  ? 'op.social_facebook'  : 'NULL AS social_facebook',
    hasCol('social_spotify')   ? 'op.social_spotify'   : 'NULL AS social_spotify',
    hasCol('social_website')   ? 'op.social_website'   : 'NULL AS social_website',
  ].join(', ');

  const row = db.prepare(`
    SELECT tic.*, op.slug, op.display_name, op.location, op.public_video_url, op.embed_video_url,
           op.short_quote, op.testimony_summary, op.status AS owner_status,
           ${optionalSelects}
    FROM testimony_item_codes tic
    LEFT JOIN owner_profiles op ON op.id = tic.owner_profile_id
    WHERE tic.item_code = ?
  `).get(itemCode);

  if (!row) {
    return { found: false, claimable: true, item_code: itemCode, ...founder };
  }

  db.prepare(`
    UPDATE testimony_item_codes
    SET first_scanned_at = COALESCE(first_scanned_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(row.id);

  if (row.owner_profile_id && row.owner_status === 'active') {
    return {
      found: true,
      claimable: true,
      mode: 'owner_profile',
      item_code: itemCode,
      owner_slug: row.slug,
      display_name: row.display_name,
      location: row.location,
      public_video_url: row.public_video_url,
      embed_video_url: row.embed_video_url,
      short_quote: row.short_quote,
      testimony_summary: row.testimony_summary,
      // Multi-format fields so story.js can render photo/audio/written correctly
      format: row.format || 'video',
      written_body: row.written_body || null,
      audio_url: row.audio_url || null,
      photo_url: row.photo_url || null,
      photo_caption: row.photo_caption || null,
      // Opt-in social links (NULL if blank, never rendered when empty per privacy policy)
      social_instagram: row.social_instagram || null,
      social_tiktok:    row.social_tiktok    || null,
      social_youtube:   row.social_youtube   || null,
      social_facebook:  row.social_facebook  || null,
      social_spotify:   row.social_spotify   || null,
      social_website:   row.social_website   || null,
      site_base_url: founder.site_base_url
    };
  }

  return { found: true, claimable: true, item_code: itemCode, ...founder };
}

function enrichSubmission(db, row) {
  const itemCodes = db.prepare(`
    SELECT tic.item_code
    FROM testimony_submission_items tsi
    JOIN testimony_item_codes tic ON tic.id = tsi.item_code_id
    WHERE tsi.submission_id = ?
    ORDER BY tic.item_code ASC
  `).all(row.id).map(entry => entry.item_code);

  return { ...row, item_codes: itemCodes };
}

function getSubmissionById(db, submissionId) {
  const row = db.prepare(`
    SELECT ts.*, sop.slug AS suggested_owner_slug, sop.display_name AS suggested_owner_name,
           lop.slug AS linked_owner_slug, lop.display_name AS linked_owner_name
    FROM testimony_submissions ts
    LEFT JOIN owner_profiles sop ON sop.id = ts.suggested_owner_profile_id
    LEFT JOIN owner_profiles lop ON lop.id = ts.linked_owner_profile_id
    WHERE ts.id = ?
  `).get(submissionId);
  return row ? enrichSubmission(db, row) : null;
}

function listSubmissions(db, filters = {}) {
  const clauses = [];
  const values = [];

  if (filters.status) {
    clauses.push('ts.review_status = ?');
    values.push(filters.status);
  }

  const sql = `
    SELECT ts.*, sop.slug AS suggested_owner_slug, sop.display_name AS suggested_owner_name,
           lop.slug AS linked_owner_slug, lop.display_name AS linked_owner_name
    FROM testimony_submissions ts
    LEFT JOIN owner_profiles sop ON sop.id = ts.suggested_owner_profile_id
    LEFT JOIN owner_profiles lop ON lop.id = ts.linked_owner_profile_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY ts.created_at DESC
    LIMIT ?
  `;
  values.push(Number(filters.limit || 200));
  return db.prepare(sql).all(...values).map(row => enrichSubmission(db, row));
}

function searchSubmissionsPaginated(db, filters = {}) {
  const clauses = [];
  const values = [];

  if (filters.status && filters.status !== 'all') {
    clauses.push('ts.review_status = ?');
    values.push(filters.status);
  }

  if (filters.query) {
    const q = `%${String(filters.query).trim()}%`;
    clauses.push(`(
      ts.submitted_name LIKE ? OR
      IFNULL(ts.submitted_email, '') LIKE ? OR
      IFNULL(ts.location, '') LIKE ? OR
      IFNULL(ts.short_quote, '') LIKE ? OR
      IFNULL(ts.testimony_summary, '') LIKE ? OR
      EXISTS (
        SELECT 1
        FROM testimony_submission_items tsi
        JOIN testimony_item_codes tic ON tic.id = tsi.item_code_id
        WHERE tsi.submission_id = ts.id AND tic.item_code LIKE ?
      )
    )`);
    values.push(q, q, q, q, q, q);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(filters.page_size || filters.pageSize || 20)));
  const offset = (page - 1) * pageSize;

  const total = db.prepare(`SELECT COUNT(*) AS count FROM testimony_submissions ts ${whereClause}`).get(...values).count;

  const rows = db.prepare(`
    SELECT ts.*, sop.slug AS suggested_owner_slug, sop.display_name AS suggested_owner_name,
           lop.slug AS linked_owner_slug, lop.display_name AS linked_owner_name
    FROM testimony_submissions ts
    LEFT JOIN owner_profiles sop ON sop.id = ts.suggested_owner_profile_id
    LEFT JOIN owner_profiles lop ON lop.id = ts.linked_owner_profile_id
    ${whereClause}
    ORDER BY ts.created_at DESC, ts.id DESC
    LIMIT ? OFFSET ?
  `).all(...values, pageSize, offset).map(row => enrichSubmission(db, row));

  return {
    ...buildPaginatedResult(rows, total, page, pageSize),
    status_counts: getSubmissionCounts(db)
  };
}

function createSubmission(db, payload) {
  const itemCodes = normalizeItemCodes(payload.item_codes || []);
  if (!payload.submitted_name || !payload.public_video_url) {
    throw new Error('submitted_name and public_video_url are required');
  }

  const itemRows = ensureItemCodesExist(db, itemCodes);
  const existingOwner = findOwnerByEmail(db, payload.submitted_email);

  const tx = db.transaction(() => {
    const submissionId = db.prepare(`
      INSERT INTO testimony_submissions (
        submitted_name, submitted_email, location, public_video_url, embed_video_url,
        short_quote, testimony_summary, admin_notes, review_status, suggested_owner_profile_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      payload.submitted_name,
      payload.submitted_email || null,
      payload.location || null,
      payload.public_video_url,
      payload.embed_video_url || payload.public_video_url,
      payload.short_quote || null,
      payload.testimony_summary || null,
      payload.admin_notes || null,
      existingOwner ? existingOwner.id : null
    ).lastInsertRowid;

    const insertLink = db.prepare(`
      INSERT OR IGNORE INTO testimony_submission_items (submission_id, item_code_id)
      VALUES (?, ?)
    `);
    itemRows.forEach(row => insertLink.run(submissionId, row.id));

    logAudit(db, 'submission_created', 'testimony_submission', submissionId, {
      item_codes: itemCodes,
      existing_owner_id: existingOwner ? existingOwner.id : null
    });

    return getSubmissionById(db, submissionId);
  });

  return tx();
}

function buildUniqueSlug(db, proposed) {
  const slugBase = slugify(proposed || nanoid(6));
  let slug = slugBase;
  let counter = 1;
  while (findOwnerBySlug(db, slug)) {
    slug = `${slugBase}-${counter++}`;
  }
  return slug;
}

function createOwner(db, payload) {
  if (!payload.display_name || !payload.public_video_url) {
    throw new Error('display_name and public_video_url are required');
  }

  const slug = buildUniqueSlug(db, payload.slug || payload.display_name);
  const ownerId = db.prepare(`
    INSERT INTO owner_profiles (
      slug, display_name, email, location, public_video_url, embed_video_url,
      short_quote, testimony_summary, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slug,
    payload.display_name,
    payload.email || null,
    payload.location || null,
    payload.public_video_url,
    payload.embed_video_url || payload.public_video_url,
    payload.short_quote || null,
    payload.testimony_summary || null,
    payload.status || 'active'
  ).lastInsertRowid;

  logAudit(db, 'owner_created', 'owner_profile', ownerId, { slug });
  return getOwnerWithItems(db, ownerId);
}

function updateOwner(db, ownerId, payload) {
  const owner = findOwnerById(db, ownerId);
  if (!owner) throw new Error('Owner not found');

  let nextSlug = owner.slug;
  if (payload.slug && payload.slug !== owner.slug) {
    const normalized = slugify(payload.slug);
    const existing = findOwnerBySlug(db, normalized);
    if (existing && existing.id !== ownerId) throw new Error('Slug already in use by another owner');
    nextSlug = normalized;
  }

  db.prepare(`
    UPDATE owner_profiles SET
      slug = ?,
      display_name = ?,
      email = ?,
      location = ?,
      public_video_url = ?,
      embed_video_url = ?,
      short_quote = ?,
      testimony_summary = ?,
      status = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    nextSlug,
    payload.display_name ?? owner.display_name,
    payload.email ?? owner.email,
    payload.location ?? owner.location,
    payload.public_video_url ?? owner.public_video_url,
    payload.embed_video_url ?? owner.embed_video_url,
    payload.short_quote ?? owner.short_quote,
    payload.testimony_summary ?? owner.testimony_summary,
    payload.status ?? owner.status,
    ownerId
  );

  logAudit(db, 'owner_updated', 'owner_profile', ownerId, payload);
  return getOwnerWithItems(db, ownerId);
}

function attachItemCodesToOwner(db, ownerId, rawItemCodes, options = {}) {
  const owner = findOwnerById(db, ownerId);
  if (!owner) throw new Error('Owner not found');
  const itemCodes = normalizeItemCodes(rawItemCodes);
  const itemRows = ensureItemCodesExist(db, itemCodes);
  const force = !!options.force;

  itemRows.forEach(row => {
    if (row.owner_profile_id && row.owner_profile_id !== ownerId && !force) {
      throw new Error(`Item code ${row.item_code} is already linked to another owner`);
    }
  });

  const tx = db.transaction(() => {
    const update = db.prepare(`
      UPDATE testimony_item_codes
      SET owner_profile_id = ?, destination_mode = 'owner_profile',
          claimed_at = COALESCE(claimed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    itemRows.forEach(row => update.run(ownerId, row.id));
    logAudit(db, 'item_codes_attached', 'owner_profile', ownerId, { item_codes: itemCodes, force });
    return getOwnerWithItems(db, ownerId);
  });

  return tx();
}

function setItemCodesToFounderDefault(db, rawItemCodes) {
  const itemCodes = normalizeItemCodes(rawItemCodes);
  const itemRows = ensureItemCodesExist(db, itemCodes);

  const tx = db.transaction(() => {
    const stmt = db.prepare(`
      UPDATE testimony_item_codes
      SET owner_profile_id = NULL, destination_mode = 'default_founder', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    itemRows.forEach(row => stmt.run(row.id));
    logAudit(db, 'item_codes_reset_default', 'testimony_item_codes', itemCodes.join(','), { item_codes: itemCodes });
    return listItemCodes(db, { query: itemCodes[0], limit: itemCodes.length });
  });

  return tx();
}

function updateSubmissionNotes(db, submissionId, adminNotes = '') {
  const submission = getSubmissionById(db, submissionId);
  if (!submission) throw new Error('Submission not found');

  db.prepare(`
    UPDATE testimony_submissions
    SET admin_notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(adminNotes || null, submissionId);

  logAudit(db, 'submission_notes_updated', 'testimony_submission', submissionId, { admin_notes: adminNotes || '' });
  return getSubmissionById(db, submissionId);
}

function approveSubmissionAsNewOwner(db, submissionId, ownerOverrides = {}) {
  const submission = getSubmissionById(db, submissionId);
  if (!submission) throw new Error('Submission not found');
  if (submission.review_status !== 'pending') throw new Error('Submission is no longer pending');

  const tx = db.transaction(() => {
    const owner = createOwner(db, {
      slug: ownerOverrides.slug,
      display_name: ownerOverrides.display_name || submission.submitted_name,
      email: ownerOverrides.email || submission.submitted_email,
      location: ownerOverrides.location || submission.location,
      public_video_url: ownerOverrides.public_video_url || submission.public_video_url,
      embed_video_url: ownerOverrides.embed_video_url || submission.embed_video_url,
      short_quote: ownerOverrides.short_quote || submission.short_quote,
      testimony_summary: ownerOverrides.testimony_summary || submission.testimony_summary,
      status: ownerOverrides.status || 'active'
    });

    attachItemCodesToOwner(db, owner.id, submission.item_codes, { force: !!ownerOverrides.force_item_reassign });

    db.prepare(`
      UPDATE testimony_submissions
      SET review_status = 'approved_new_owner',
          linked_owner_profile_id = ?,
          admin_notes = ?,
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(owner.id, ownerOverrides.admin_notes || submission.admin_notes || null, submissionId);

    logAudit(db, 'submission_approved_new_owner', 'testimony_submission', submissionId, {
      owner_id: owner.id,
      item_codes: submission.item_codes
    });

    return {
      owner: getOwnerWithItems(db, owner.id),
      submission: getSubmissionById(db, submissionId)
    };
  });

  return tx();
}

function linkSubmissionToExistingOwner(db, submissionId, ownerId, options = {}) {
  const submission = getSubmissionById(db, submissionId);
  const owner = findOwnerById(db, ownerId);
  if (!submission) throw new Error('Submission not found');
  if (!owner) throw new Error('Owner not found');
  if (submission.review_status !== 'pending') throw new Error('Submission is no longer pending');

  const tx = db.transaction(() => {
    attachItemCodesToOwner(db, ownerId, submission.item_codes, { force: !!options.force_item_reassign });

    if (options.replace_owner_video) {
      updateOwner(db, ownerId, {
        public_video_url: options.public_video_url || submission.public_video_url,
        embed_video_url: options.embed_video_url || submission.embed_video_url,
        short_quote: options.short_quote || submission.short_quote,
        testimony_summary: options.testimony_summary || submission.testimony_summary,
        location: options.location || submission.location,
        email: options.email || submission.submitted_email
      });
    }

    db.prepare(`
      UPDATE testimony_submissions
      SET review_status = 'merged_to_existing',
          linked_owner_profile_id = ?,
          admin_notes = ?,
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(ownerId, options.admin_notes || submission.admin_notes || null, submissionId);

    logAudit(db, 'submission_linked_existing_owner', 'testimony_submission', submissionId, {
      owner_id: ownerId,
      item_codes: submission.item_codes,
      replace_owner_video: !!options.replace_owner_video
    });

    return {
      owner: getOwnerWithItems(db, ownerId),
      submission: getSubmissionById(db, submissionId)
    };
  });

  return tx();
}

function rejectSubmission(db, submissionId, adminNotes = '') {
  const submission = getSubmissionById(db, submissionId);
  if (!submission) throw new Error('Submission not found');

  db.prepare(`
    UPDATE testimony_submissions
    SET review_status = 'rejected', admin_notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(adminNotes || submission.admin_notes || null, submissionId);

  logAudit(db, 'submission_rejected', 'testimony_submission', submissionId, { admin_notes: adminNotes || '' });
  return getSubmissionById(db, submissionId);
}

function bulkRejectSubmissions(db, submissionIds = [], adminNotes = '') {
  const ids = [...new Set((submissionIds || []).map(id => Number(id)).filter(Boolean))];
  if (!ids.length) throw new Error('submission_ids is required');

  const tx = db.transaction(() => {
    const updated = [];
    const skipped = [];
    ids.forEach(id => {
      const submission = getSubmissionById(db, id);
      if (!submission) {
        skipped.push({ id, reason: 'not_found' });
        return;
      }
      if (submission.review_status !== 'pending') {
        skipped.push({ id, reason: `not_pending:${submission.review_status}` });
        return;
      }
      rejectSubmission(db, id, adminNotes);
      updated.push(id);
    });

    logAudit(db, 'submissions_bulk_rejected', 'testimony_submission', updated.join(','), {
      updated_count: updated.length,
      skipped,
      admin_notes: adminNotes || ''
    });

    return { updated_ids: updated, skipped };
  });

  return tx();
}

function getDashboardSummary(db) {
  return {
    pending_submissions: db.prepare("SELECT COUNT(*) AS count FROM testimony_submissions WHERE review_status = 'pending'").get().count,
    approved_owners: db.prepare("SELECT COUNT(*) AS count FROM owner_profiles WHERE status = 'active'").get().count,
    linked_item_codes: db.prepare("SELECT COUNT(*) AS count FROM testimony_item_codes WHERE destination_mode = 'owner_profile'").get().count,
    default_item_codes: db.prepare("SELECT COUNT(*) AS count FROM testimony_item_codes WHERE destination_mode = 'default_founder'").get().count,
    founder_defaults: getFounderPayload(db),
    submission_counts: getSubmissionCounts(db)
  };
}

function listOwners(db, query = '', limit = 100) {
  const q = `%${String(query || '').trim()}%`;
  const rows = db.prepare(`
    SELECT op.*, COUNT(tic.id) AS linked_item_count
    FROM owner_profiles op
    LEFT JOIN testimony_item_codes tic ON tic.owner_profile_id = op.id
    WHERE op.display_name LIKE ? OR IFNULL(op.email, '') LIKE ? OR op.slug LIKE ?
    GROUP BY op.id
    ORDER BY op.updated_at DESC
    LIMIT ?
  `).all(q, q, q, Number(limit));

  return rows.map(row => ({
    ...row,
    linked_item_codes: db.prepare('SELECT item_code FROM testimony_item_codes WHERE owner_profile_id = ? ORDER BY item_code ASC').all(row.id).map(x => x.item_code)
  }));
}

function searchOwnersPaginated(db, filters = {}) {
  const clauses = [];
  const values = [];

  if (filters.status && filters.status !== 'all') {
    clauses.push('op.status = ?');
    values.push(filters.status);
  }

  if (filters.query) {
    const q = `%${String(filters.query).trim()}%`;
    clauses.push('(op.display_name LIKE ? OR IFNULL(op.email, "") LIKE ? OR op.slug LIKE ? OR EXISTS (SELECT 1 FROM testimony_item_codes tic WHERE tic.owner_profile_id = op.id AND tic.item_code LIKE ?))');
    values.push(q, q, q, q);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(filters.page_size || filters.pageSize || 20)));
  const offset = (page - 1) * pageSize;

  const total = db.prepare(`SELECT COUNT(*) AS count FROM owner_profiles op ${whereClause}`).get(...values).count;
  const rows = db.prepare(`
    SELECT op.*, COUNT(tic.id) AS linked_item_count
    FROM owner_profiles op
    LEFT JOIN testimony_item_codes tic ON tic.owner_profile_id = op.id
    ${whereClause}
    GROUP BY op.id
    ORDER BY op.updated_at DESC, op.id DESC
    LIMIT ? OFFSET ?
  `).all(...values, pageSize, offset);

  const items = rows.map(row => ({
    ...row,
    linked_item_codes: db.prepare('SELECT item_code FROM testimony_item_codes WHERE owner_profile_id = ? ORDER BY item_code ASC').all(row.id).map(x => x.item_code)
  }));

  return buildPaginatedResult(items, total, page, pageSize);
}

function bulkImportItemCodes(db, rawItemCodes) {
  const itemCodes = normalizeItemCodes(rawItemCodes);
  const rows = ensureItemCodesExist(db, itemCodes);
  logAudit(db, 'item_codes_imported', 'testimony_item_codes', itemCodes.join(','), { count: itemCodes.length });
  return rows;
}

function listAuditLogs(db, limit = 100) {
  return db.prepare(`
    SELECT *
    FROM admin_audit_logs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(Number(limit));
}

module.exports = {
  slugify,
  normalizeItemCodes,
  getFounderPayload,
  updateFounderPayload,
  resolveItemCode,
  createSubmission,
  listSubmissions,
  searchSubmissionsPaginated,
  getSubmissionById,
  updateSubmissionNotes,
  createOwner,
  updateOwner,
  attachItemCodesToOwner,
  setItemCodesToFounderDefault,
  approveSubmissionAsNewOwner,
  linkSubmissionToExistingOwner,
  rejectSubmission,
  bulkRejectSubmissions,
  getDashboardSummary,
  getSubmissionCounts,
  listOwners,
  searchOwnersPaginated,
  getOwnerWithItems,
  listItemCodes,
  bulkImportItemCodes,
  listAuditLogs,
  getSetting,
  setSetting
};