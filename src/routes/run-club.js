// src/routes/run-club.js
// Runners for Christ — Danbury CT Athletes of Christ run club organized by
// JESUS IS MY KING MOVEMENT.
//
// Public:
//   GET  /api/public/run-club
//     -> { active, club_name, tagline, meeting_day, meeting_time, location_name,
//          location_address, special_notes, strava_url, aoc_url, contact_email }
//
// Admin (x-admin-key):
//   PATCH /api/admin/run-club
//     Body: any subset of the fields above. Saves to site_settings using runclub.* keys
//     so no schema migration is required.

'use strict';

const express = require('express');
const { getDb } = require('../db/client');

const router = express.Router();

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY || 'change-this-admin-key';
  if (!key || key !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function getSetting(db, key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
    return row && row.value != null ? row.value : fallback;
  } catch (e) { return fallback; }
}

function setSetting(db, key, value) {
  const existing = db.prepare('SELECT key FROM site_settings WHERE key = ?').get(key);
  if (existing) {
    db.prepare('UPDATE site_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?').run(String(value ?? ''), key);
  } else {
    db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run(key, String(value ?? ''));
  }
}

const DEFAULTS = {
  active: 'true',
  club_name: 'Runners for Christ',
  tagline: 'A Danbury-based run club for people who love Christ and love running.',
  meeting_day: 'Saturday',
  meeting_time: '10:00 AM',
  location_name: '',
  location_address: 'Danbury, CT',
  special_notes: 'Each meet includes prayer, fellowship, and testimonials. All paces welcome.',
  strava_url: 'https://strava.app.link/LoKWKWxTK3b',
  aoc_url: 'https://athletesofchrist.com/',
  contact_email: 'chris@jesusismykingmovement.com',
  // Calendar fields (admin-editable). first_meeting_date is ISO YYYY-MM-DD.
  // meeting_start_time is 24-hour HH:MM (used to build calendar event start).
  // meeting_duration_min is integer string. meeting_recurrence drives the RRULE
  // used by the .ics export and Google/Outlook add-event links.
  first_meeting_date: '',
  meeting_start_time: '10:00',
  meeting_duration_min: '90',
  meeting_recurrence: 'weekly-saturday'
};

function readAll(db) {
  return {
    active: getSetting(db, 'runclub.active', DEFAULTS.active) === 'true',
    club_name: getSetting(db, 'runclub.club_name', DEFAULTS.club_name),
    tagline: getSetting(db, 'runclub.tagline', DEFAULTS.tagline),
    meeting_day: getSetting(db, 'runclub.meeting_day', DEFAULTS.meeting_day),
    meeting_time: getSetting(db, 'runclub.meeting_time', DEFAULTS.meeting_time),
    location_name: getSetting(db, 'runclub.location_name', DEFAULTS.location_name),
    location_address: getSetting(db, 'runclub.location_address', DEFAULTS.location_address),
    special_notes: getSetting(db, 'runclub.special_notes', DEFAULTS.special_notes),
    strava_url: getSetting(db, 'runclub.strava_url', DEFAULTS.strava_url),
    aoc_url: getSetting(db, 'runclub.aoc_url', DEFAULTS.aoc_url),
    contact_email: getSetting(db, 'runclub.contact_email', DEFAULTS.contact_email),
    first_meeting_date: getSetting(db, 'runclub.first_meeting_date', DEFAULTS.first_meeting_date),
    meeting_start_time: getSetting(db, 'runclub.meeting_start_time', DEFAULTS.meeting_start_time),
    meeting_duration_min: getSetting(db, 'runclub.meeting_duration_min', DEFAULTS.meeting_duration_min),
    meeting_recurrence: getSetting(db, 'runclub.meeting_recurrence', DEFAULTS.meeting_recurrence)
  };
}

router.get('/public/run-club', (req, res) => {
  try {
    const db = getDb();
    res.json(readAll(db));
  } catch (e) {
    console.error('run-club read error:', e);
    res.status(500).json({ error: 'read_failed', message: e.message });
  }
});

const ALLOWED_FIELDS = [
  'active', 'club_name', 'tagline',
  'meeting_day', 'meeting_time',
  'location_name', 'location_address',
  'special_notes',
  'strava_url', 'aoc_url', 'contact_email',
  // Calendar fields
  'first_meeting_date', 'meeting_start_time', 'meeting_duration_min', 'meeting_recurrence'
];

router.patch('/admin/run-club', adminAuth, express.json({ limit: '32kb' }), (req, res) => {
  try {
    const db = getDb();
    const b = req.body || {};
    for (const field of ALLOWED_FIELDS) {
      if (b[field] == null) continue;
      let value = b[field];
      if (field === 'active') value = value === true || value === 'true' ? 'true' : 'false';
      setSetting(db, 'runclub.' + field, String(value).slice(0, 1000));
    }
    res.json({ ok: true, runclub: readAll(db) });
  } catch (e) {
    console.error('run-club update error:', e);
    res.status(500).json({ error: 'update_failed', message: e.message });
  }
});

module.exports = router;
