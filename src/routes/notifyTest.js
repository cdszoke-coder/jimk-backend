'use strict';
// -----------------------------------------------------------------------------
// notifyTest.js — one private endpoint to prove your testimony texts work.
//
//   GET /api/admin/notify-test?key=YOUR_NOTIFY_TEST_KEY
//
// Set NOTIFY_TEST_KEY on Render to any long random string. Without that env var
// the endpoint stays switched off (404), so it can never leak.
// It sends a real test alert through whichever channel notifyOwner has active.
// -----------------------------------------------------------------------------

const express = require('express');
const notifyOwner = require('../lib/notifyOwner');

const router = express.Router();

router.get('/admin/notify-test', async (req, res) => {
  const expected = (process.env.NOTIFY_TEST_KEY || '').trim();
  if (!expected) return res.status(404).json({ error: 'not found' });

  const given = String(req.query.key || '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const same = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  if (!same) return res.status(401).json({ error: 'unauthorized' });

  const state = notifyOwner.channelState();
  const result = await notifyOwner.notifyOwner({ test: true }, { quiet: true });

  res.json({
    active_channel: state.active,
    configured: {
      twilio_ready: state.twilioReady,
      ntfy_ready: state.ntfyReady,
      pushover_ready: state.pushoverReady,
      owner_phone_set: !!notifyOwner.config.ownerPhone,
    },
    missing_env_vars: state.missing,
    sent: result.ok,
    http_status: result.status,
    detail: result.detail,
    note: result.ok
      ? 'Check your phone — the test alert is on its way.'
      : 'Nothing sent. Read missing_env_vars / detail above, fix it on Render, redeploy, then try again.',
  });
});

module.exports = router;
