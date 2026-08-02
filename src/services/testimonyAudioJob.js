'use strict';

/**
 * src/services/testimonyAudioJob.js
 *
 * Async post-approval worker for AUDIO testimonies.
 *
 * When an admin approves a testimony whose format === 'audio', the approve
 * route calls startAudioTestimonyJob() with the intake id + newly-created
 * owner_profile id. This module then, in the background:
 *
 *   1. Loads the intake + owner rows.
 *   2. Resolves the audio file on the Render disk from the stored /uploads URL.
 *   3. Runs ffmpeg to render an MP4 with the JIMK still-frame + pulse animation.
 *   4. Uploads the MP4 to the connected JIMK YouTube channel as UNLISTED.
 *   5. Adds the resulting video to the "Testimonials" playlist.
 *   6. Updates owner_profiles: format='video', public_video_url,
 *      embed_video_url. audio_url is preserved for the story page fallback.
 *   7. Logs a row in an audio_job_log audit table (auto-created on first run).
 *
 * Failures are logged but never thrown to the HTTP layer — the admin approval
 * has already returned 200 by the time this job runs.
 *
 * Design notes:
 *   - setImmediate() kick-off so the HTTP response is sent first.
 *   - Serialized queue (one active job at a time) so simultaneous approvals
 *     do not blow up ffmpeg memory on Render's shared box.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { audioToTestimonyVideo, tempOutputPathForIntake } = require('./audioToVideo');

let yt = null;
try { yt = require('./youtubeService'); }
catch (err) { console.warn('[testimonyAudioJob] youtubeService not loaded:', err.message); }

const { getDb } = require('../db/client');

/* --------------------- audit table --------------------- */
function ensureAuditTable(db) {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS audio_job_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intake_id INTEGER,
      owner_profile_id INTEGER,
      status TEXT NOT NULL,
      video_id TEXT,
      public_video_url TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();
  } catch (_) { /* ignore */ }
}
function log(db, row) {
  try {
    ensureAuditTable(db);
    db.prepare(`INSERT INTO audio_job_log
      (intake_id, owner_profile_id, status, video_id, public_video_url, error)
      VALUES (@intake_id, @owner_profile_id, @status, @video_id, @public_video_url, @error)`
    ).run({
      intake_id: row.intake_id || null,
      owner_profile_id: row.owner_profile_id || null,
      status: row.status || 'unknown',
      video_id: row.video_id || null,
      public_video_url: row.public_video_url || null,
      error: row.error ? String(row.error).slice(0, 2000) : null
    });
  } catch (e) {
    console.warn('[testimonyAudioJob] audit insert failed:', e.message);
  }
}

/* --------------------- audio URL -> local path --------------------- */
/**
 * The submitter uploaded to /uploads/testimony-audio/<file>. testimony-submit.js
 * writes the public URL like `${backend}/uploads/testimony-audio/<file>` to
 * intake.audio_url. This function resolves that URL back to an on-disk path
 * inside the Render persistent volume.
 */
function resolveAudioAbsolutePath(audioUrl) {
  if (!audioUrl) return null;
  const uploadsDir = process.env.UPLOADS_DIR
    || '/opt/render/project/src/data/uploads';
  try {
    const u = new URL(audioUrl);
    const relFromUploads = u.pathname.replace(/^\/+/, '').replace(/^uploads\//, '');
    const abs = path.join(uploadsDir, relFromUploads);
    if (fs.existsSync(abs)) return abs;
  } catch (_) { /* fall through */ }
  // Not a URL — treat as relative or absolute path directly.
  if (path.isAbsolute(audioUrl) && fs.existsSync(audioUrl)) return audioUrl;
  const rel = String(audioUrl).replace(/^\/+/, '').replace(/^uploads\//, '');
  const abs2 = path.join(uploadsDir, rel);
  if (fs.existsSync(abs2)) return abs2;
  return null;
}

/* --------------------- description builder --------------------- */
/**
 * YouTube description built from submitter-provided fields — never a
 * hardcoded string. All fields are optional except display_name.
 */
function buildDescription({ displayName, location, shortQuote, writtenBody, slug }) {
  const parts = [];
  parts.push(`${displayName} — Shared Testimony`);

  if (shortQuote && shortQuote.trim()) {
    parts.push('');
    parts.push(`"${shortQuote.trim()}"`);
  }

  if (writtenBody && writtenBody.trim()) {
    parts.push('');
    parts.push(writtenBody.trim());
  } else if (location && location.trim()) {
    parts.push('');
    parts.push(`Audio testimony from ${location.trim()}.`);
  }

  parts.push('');
  parts.push('Recorded as part of Jesus Is My King Movement.');
  if (slug) {
    parts.push(`Watch: https://www.jesusismykingmovement.com/story.html?id=${encodeURIComponent(slug)}`);
  } else {
    parts.push('Watch: https://www.jesusismykingmovement.com/movement.html');
  }
  parts.push('');
  parts.push('All glory to God.');

  return parts.join('\n').slice(0, 4500);
}

/* --------------------- serialized queue --------------------- */
const queue = [];
let running = false;

function schedule(fn) {
  queue.push(fn);
  if (!running) drain();
}

async function drain() {
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try { await job(); }
    catch (e) { console.error('[testimonyAudioJob] queue task failed:', e); }
  }
  running = false;
}

/* --------------------- public entrypoint --------------------- */
/**
 * Kick off the audio -> video -> YouTube pipeline for one approved intake.
 * Returns immediately; work happens in the background.
 */
function startAudioTestimonyJob({ intakeId, ownerProfileId }) {
  setImmediate(() => schedule(() => runJob({ intakeId, ownerProfileId })));
}

async function runJob({ intakeId, ownerProfileId }) {
  const db = getDb();
  ensureAuditTable(db);

  const intake = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(intakeId);
  const owner  = db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(ownerProfileId);

  if (!intake) return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: 'intake row missing' });
  if (!owner)  return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: 'owner row missing' });

  const audioUrl = intake.audio_url || owner.audio_url;
  if (!audioUrl) return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: 'no audio_url on intake or owner' });

  const audioAbs = resolveAudioAbsolutePath(audioUrl);
  if (!audioAbs) return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: `audio file not found on disk for ${audioUrl}` });

  const displayName = (owner.display_name || intake.display_name || 'Anonymous').trim();
  const location    = (owner.location || intake.location || '').trim();
  const shortQuote  = (owner.short_quote || intake.short_quote || '').trim();
  const writtenBody = (intake.written_body || '').trim();
  const slug        = owner.slug || '';

  if (!yt || !yt.isConnected || !yt.isConnected()) {
    return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: 'YouTube is not connected' });
  }

  const outPath = tempOutputPathForIntake(intakeId);

  try {
    log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'rendering' });

    const { durationSec } = await audioToTestimonyVideo({
      audioPath: audioAbs,
      displayName,
      location,
      outPath
    });

    log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'uploading' });

    const title = `${displayName} — Shared Testimony`.slice(0, 100);
    const description = buildDescription({ displayName, location, shortQuote, writtenBody, slug });

    const ytRes = await yt.uploadVideoFromPath(outPath, {
      title,
      description,
      privacyStatus: 'unlisted',
      tags: ['testimony', 'audio', 'jesusismykingmovement']
    });

    const videoId = ytRes.id;
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const embedUrl = `https://www.youtube.com/embed/${videoId}`;

    // Best-effort playlist add — non-fatal.
    try {
      if (typeof yt.addVideoToTestimonialsPlaylist === 'function') {
        await yt.addVideoToTestimonialsPlaylist(videoId);
      }
    } catch (e) {
      console.warn('[testimonyAudioJob] playlist add failed (non-fatal):', e.message);
    }

    // Patch owner row: promote to video, keep audio_url for fallback rendering.
    db.prepare(`UPDATE owner_profiles
      SET format = 'video',
          public_video_url = ?,
          embed_video_url = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(watchUrl, embedUrl, ownerProfileId);

    log(db, {
      intake_id: intakeId,
      owner_profile_id: ownerProfileId,
      status: 'done',
      video_id: videoId,
      public_video_url: watchUrl
    });

    console.log(`[testimonyAudioJob] intake ${intakeId} -> ${watchUrl} (${durationSec ? Math.round(durationSec) + 's' : 'unknown duration'})`);
  } catch (err) {
    console.error('[testimonyAudioJob] job failed:', err);
    log(db, {
      intake_id: intakeId,
      owner_profile_id: ownerProfileId,
      status: 'error',
      error: err.message || String(err)
    });
  } finally {
    try { fs.unlinkSync(outPath); } catch (_) {}
  }
}

module.exports = {
  startAudioTestimonyJob,
  runJob,           // exported for admin retry endpoints
  buildDescription, // exported for tests
  resolveAudioAbsolutePath
};
