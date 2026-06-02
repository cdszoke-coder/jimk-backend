const express = require('express');
const { getDb } = require('../db/client');
const adminAuth = require('../middleware/adminAuth');
const { ok, badRequest, notFound } = require('../utils/http');
const {
  getDashboardSummary,
  searchSubmissionsPaginated,
  getSubmissionById,
  updateSubmissionNotes,
  approveSubmissionAsNewOwner,
  linkSubmissionToExistingOwner,
  rejectSubmission,
  bulkRejectSubmissions,
  searchOwnersPaginated,
  getOwnerWithItems,
  createOwner,
  updateOwner,
  attachItemCodesToOwner,
  setItemCodesToFounderDefault,
  listItemCodes,
  bulkImportItemCodes,
  updateFounderPayload,
  listAuditLogs
} = require('../services/testimonyService');
const {
  assertRequired,
  normalizeOwnerPayload,
  normalizeSubmissionPayload
} = require('../utils/validators');

const router = express.Router();
const { adminRouter: artistsAdminRouter } = require('./artists');

router.use(adminAuth);
router.use(artistsAdminRouter);

router.get('/dashboard', (req, res) => {
  const db = getDb();
  return ok(res, {
    summary: getDashboardSummary(db),
    submissions: searchSubmissionsPaginated(db, {
      status: req.query.status || 'pending',
      query: req.query.query || '',
      page: req.query.page || 1,
      page_size: req.query.page_size || 20
    }),
    owners: searchOwnersPaginated(db, {
      query: req.query.owner_query || '',
      status: req.query.owner_status || 'all',
      page: req.query.owner_page || 1,
      page_size: req.query.owner_page_size || 10
    })
  });
});

router.get('/submissions', (req, res) => {
  const db = getDb();
  return ok(res, searchSubmissionsPaginated(db, {
    status: req.query.status || 'all',
    query: req.query.query || '',
    page: req.query.page || 1,
    page_size: req.query.page_size || 20
  }));
});

router.post('/submissions/bulk-reject', (req, res) => {
  try {
    const db = getDb();
    const result = bulkRejectSubmissions(db, req.body.submission_ids || req.body.submissionIds || [], req.body.admin_notes || '');
    return ok(res, result);
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.get('/submissions/:id', (req, res) => {
  const db = getDb();
  const submission = getSubmissionById(db, Number(req.params.id));
  if (!submission) return notFound(res, 'Submission not found');
  return ok(res, { submission });
});

router.patch('/submissions/:id/notes', (req, res) => {
  try {
    const db = getDb();
    const submission = updateSubmissionNotes(db, Number(req.params.id), req.body.admin_notes || '');
    return ok(res, { submission });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.post('/submissions/:id/approve-new-owner', (req, res) => {
  try {
    const db = getDb();
    const submissionId = Number(req.params.id);
    const ownerPayload = normalizeOwnerPayload(req.body || {});
    const result = approveSubmissionAsNewOwner(db, submissionId, {
      ...ownerPayload,
      admin_notes: req.body.admin_notes,
      force_item_reassign: !!req.body.force_item_reassign
    });
    return ok(res, result);
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.post('/submissions/:id/link-owner', (req, res) => {
  try {
    const db = getDb();
    const submissionId = Number(req.params.id);
    const ownerId = Number(req.body.owner_id);
    if (!ownerId) return badRequest(res, 'owner_id is required');
    const submissionPatch = normalizeSubmissionPayload(req.body || {});
    const result = linkSubmissionToExistingOwner(db, submissionId, ownerId, {
      replace_owner_video: !!req.body.replace_owner_video,
      force_item_reassign: !!req.body.force_item_reassign,
      public_video_url: submissionPatch.public_video_url,
      embed_video_url: submissionPatch.embed_video_url,
      short_quote: submissionPatch.short_quote,
      testimony_summary: submissionPatch.testimony_summary,
      location: submissionPatch.location,
      email: submissionPatch.submitted_email,
      admin_notes: req.body.admin_notes
    });
    return ok(res, result);
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.post('/submissions/:id/reject', (req, res) => {
  try {
    const db = getDb();
    const submission = rejectSubmission(db, Number(req.params.id), req.body.admin_notes || '');
    return ok(res, { submission });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.get('/owners', (req, res) => {
  const db = getDb();
  return ok(res, searchOwnersPaginated(db, {
    query: req.query.query || '',
    status: req.query.status || 'all',
    page: req.query.page || 1,
    page_size: req.query.page_size || 20
  }));
});

router.get('/owners/:id', (req, res) => {
  const db = getDb();
  const owner = getOwnerWithItems(db, Number(req.params.id));
  if (!owner) return notFound(res, 'Owner not found');
  return ok(res, { owner });
});

router.post('/owners', (req, res) => {
  try {
    const db = getDb();
    const payload = normalizeOwnerPayload(req.body || {});
    assertRequired(['display_name', 'public_video_url'], payload);
    const owner = createOwner(db, payload);
    if (req.body.item_codes) {
      attachItemCodesToOwner(db, owner.id, req.body.item_codes, { force: !!req.body.force_item_reassign });
    }
    return res.status(201).json({ owner: getOwnerWithItems(db, owner.id) });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.patch('/owners/:id', (req, res) => {
  try {
    const db = getDb();
    const payload = normalizeOwnerPayload(req.body || {});
    const owner = updateOwner(db, Number(req.params.id), payload);
    return ok(res, { owner });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.post('/owners/:id/link-item-codes', (req, res) => {
  try {
    const db = getDb();
    const itemCodes = req.body.item_codes || req.body.itemCodes;
    if (!itemCodes) return badRequest(res, 'item_codes is required');
    const owner = attachItemCodesToOwner(db, Number(req.params.id), itemCodes, { force: !!req.body.force_item_reassign });
    return ok(res, { owner });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.post('/item-codes/import', (req, res) => {
  try {
    const db = getDb();
    const rows = bulkImportItemCodes(db, req.body.item_codes || req.body.itemCodes || []);
    return res.status(201).json({ imported_count: rows.length, item_codes: rows });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.post('/item-codes/reset-default', (req, res) => {
  try {
    const db = getDb();
    const rows = setItemCodesToFounderDefault(db, req.body.item_codes || req.body.itemCodes || []);
    return ok(res, { item_codes: rows });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.get('/item-codes', (req, res) => {
  const db = getDb();
  return ok(res, {
    item_codes: listItemCodes(db, {
      status: req.query.status,
      query: req.query.query,
      limit: req.query.limit || 200,
      offset: req.query.offset || 0
    })
  });
});

router.patch('/settings/founder', (req, res) => {
  try {
    const db = getDb();
    const founder = updateFounderPayload(db, req.body || {});
    return ok(res, { founder });
  } catch (error) {
    return badRequest(res, error.message);
  }
});

router.get('/audit-logs', (req, res) => {
  const db = getDb();
  return ok(res, { logs: listAuditLogs(db, req.query.limit || 100) });
});

module.exports = router;