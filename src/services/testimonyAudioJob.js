'use strict';

/**
 * src/services/testimonyAudioJob.js  (v2 — karaoke + music bed)
 *
 * Async post-approval worker for AUDIO testimonies. Unchanged contract from v1;
 * the render now includes word-synced karaoke subtitles and a royalty-free
 * piano bed when those subsystems are available.
 *
 * Pipeline:
 *   1. Load intake + owner rows.
 *   2. Resolve audio file on the Render disk.
 *   3. ffmpeg render (JIMK frame + pulse + karaoke + piano mix).
 *   4. Upload MP4 to JIMK YouTube as UNLISTED.
 *   5. Add to "Testimonials" playlist.
 *   6. Patch owner_profiles (format='video', public_video_url, embed_video_url).
 *   7. Audit row in audio_job_log (now also records subtitles/music flags).
 */

const path = require('path');
const fs = require('fs');

const { audioToTestimonyVideo, videoToTestimonyVideo, tempOutputPathForIntake } = require('./audioToVideo');

let yt = null;
try { yt = require('./youtubeService'); }
catch (err) { console.warn('[testimonyAudioJob] youtubeService not loaded:', err.message); }

const { getDb } = require('../db/client');

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

function resolveMediaAbsolutePath(audioUrl) {
  if (!audioUrl) return null;
  const uploadsDir = process.env.UPLOADS_DIR || '/opt/render/project/src/data/uploads';
  try {
    const u = new URL(audioUrl);
    const relFromUploads = u.pathname.replace(/^\/+/, '').replace(/^uploads\//, '');
    const abs = path.join(uploadsDir, relFromUploads);
    if (fs.existsSync(abs)) return abs;
  } catch (_) { /* fall through */ }
  if (path.isAbsolute(audioUrl) && fs.existsSync(audioUrl)) return audioUrl;
  const rel = String(audioUrl).replace(/^\/+/, '').replace(/^uploads\//, '');
  const abs2 = path.join(uploadsDir, rel);
  if (fs.existsSync(abs2)) return abs2;
  return null;
}

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

function startAudioTestimonyJob({ intakeId, ownerProfileId }) {
  setImmediate(() => schedule(() => runJob({ intakeId, ownerProfileId })));
}

function startVideoTestimonyJob({ intakeId, ownerProfileId }) {
  setImmediate(() => schedule(() => runVideoJob({ intakeId, ownerProfileId })));
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

  const audioAbs = resolveMediaAbsolutePath(audioUrl);
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

    const { durationSec, hasSubtitles, hasMusicBed } = await audioToTestimonyVideo({
      audioPath: audioAbs,
      displayName,
      location,
      outPath
    });

    log(db, {
      intake_id: intakeId,
      owner_profile_id: ownerProfileId,
      status: 'uploading',
      error: `rendered with subtitles=${hasSubtitles ? 'yes' : 'no'} music=${hasMusicBed ? 'yes' : 'no'}`
    });

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

    try {
      if (typeof yt.addVideoToTestimonialsPlaylist === 'function') {
        await yt.addVideoToTestimonialsPlaylist(videoId);
      }
    } catch (e) {
      console.warn('[testimonyAudioJob] playlist add failed (non-fatal):', e.message);
    }

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

async function runVideoJob({ intakeId, ownerProfileId }) {
  const db = getDb();
  ensureAuditTable(db);

  const intake = db.prepare('SELECT * FROM testimony_intake WHERE id = ?').get(intakeId);
  const owner  = db.prepare('SELECT * FROM owner_profiles WHERE id = ?').get(ownerProfileId);

  if (!intake) return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: 'intake row missing' });
  if (!owner)  return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: 'owner row missing' });

  const videoUrl = intake.video_file_url || owner.video_file_url;
  if (!videoUrl) return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: 'no video_file_url on intake or owner' });

  const videoAbs = resolveMediaAbsolutePath(videoUrl);
  if (!videoAbs) return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: `video file not found on disk for ${videoUrl}` });

  const displayName = (owner.display_name || intake.display_name || 'Anonymous').trim();
  const location    = (owner.location || intake.location || '').trim();
  const shortQuote  = (owner.short_quote || intake.short_quote || '').trim();
  const writtenBody = (intake.written_body || '').trim();
  const slug        = owner.slug || '';

  if (!yt || !yt.isConnected || !yt.isConnected()) {
    return log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'error', error: 'YouTube is not connected' });
  }

  const outPath = tempOutputPathForIntake(`v${intakeId}`);

  try {
    log(db, { intake_id: intakeId, owner_profile_id: ownerProfileId, status: 'rendering' });

    const { durationSec, hasSubtitles, hasMusicBed } = await videoToTestimonyVideo({
      videoPath: videoAbs,
      outPath
    });

    log(db, {
      intake_id: intakeId,
      owner_profile_id: ownerProfileId,
      status: 'uploading',
      error: `rendered with subtitles=${hasSubtitles ? 'yes' : 'no'} music=${hasMusicBed ? 'yes' : 'no'}`
    });

    const title = `${displayName} — Shared Testimony`.slice(0, 100);
    const description = buildDescription({ displayName, location, shortQuote, writtenBody, slug });

    const ytRes = await yt.uploadVideoFromPath(outPath, {
      title,
      description,
      privacyStatus: 'unlisted',
      tags: ['testimony', 'video', 'jesusismykingmovement']
    });

    const videoId = ytRes.id;
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const embedUrl = `https://www.youtube.com/embed/${videoId}`;

    try {
      if (typeof yt.addVideoToTestimonialsPlaylist === 'function') {
        await yt.addVideoToTestimonialsPlaylist(videoId);
      }
    } catch (e) {
      console.warn('[testimonyAudioJob] playlist add failed (non-fatal):', e.message);
    }

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

    console.log(`[testimonyAudioJob] video intake ${intakeId} -> ${watchUrl} (${durationSec ? Math.round(durationSec) + 's' : 'unknown duration'})`);
  } catch (err) {
    console.error('[testimonyAudioJob] video job failed:', err);
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
  startVideoTestimonyJob,
  runJob,
  runVideoJob,
  buildDescription,
  resolveMediaAbsolutePath,
  resolveAudioAbsolutePath: resolveMediaAbsolutePath
};
