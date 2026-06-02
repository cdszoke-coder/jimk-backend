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