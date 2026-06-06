'use strict';

/**
 * YouTube upload service for JIMK testimony system.
 *
 * Responsibilities:
 *  - Hold OAuth tokens (refresh + access) in SQLite
 *  - Refresh access tokens automatically
 *  - Upload videos via resumable upload to the connected YouTube channel
 *  - Add uploaded videos to the Testimonials playlist (create if missing)
 *  - Update privacy (public / unlisted / private)
 *
 * Reads credentials from env:
 *  - YT_CLIENT_ID
 *  - YT_CLIENT_SECRET
 *  - YT_REDIRECT_URI
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const { getDb } = require('../db/client');

const CLIENT_ID = process.env.YT_CLIENT_ID || '';
const CLIENT_SECRET = process.env.YT_CLIENT_SECRET || '';
const REDIRECT_URI =
  process.env.YT_REDIRECT_URI ||
  'https://jimk-backend.onrender.com/api/public/youtube/oauth/callback';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly'
].join(' ');

function nowMs() { return Date.now(); }

function getOAuthRow() {
  const db = getDb();
  return db.prepare('SELECT * FROM youtube_oauth_tokens WHERE id = 1').get();
}

function saveOAuthRow(row) {
  const db = getDb();
  const existing = getOAuthRow();
  if (existing) {
    db.prepare(`UPDATE youtube_oauth_tokens
      SET channel_id=@channel_id, channel_title=@channel_title,
          access_token=@access_token, refresh_token=COALESCE(@refresh_token, refresh_token),
          scope=@scope, token_type=@token_type, expiry_ms=@expiry_ms,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=1`).run(row);
  } else {
    db.prepare(`INSERT INTO youtube_oauth_tokens
      (id, channel_id, channel_title, access_token, refresh_token, scope, token_type, expiry_ms)
      VALUES (1, @channel_id, @channel_title, @access_token, @refresh_token, @scope, @token_type, @expiry_ms)
    `).run(row);
  }
}

function getSettings() {
  const db = getDb();
  return db.prepare('SELECT * FROM youtube_settings WHERE id = 1').get() || {};
}

function setTestimonialsPlaylistId(playlistId) {
  const db = getDb();
  db.prepare(`UPDATE youtube_settings SET testimonials_playlist_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(playlistId);
}

function setArtistsPlaylistId(playlistId) {
  const db = getDb();
  // Safe upgrade: if column missing on an old install, add it first
  try {
    db.prepare(`UPDATE youtube_settings SET artists_playlist_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(playlistId);
  } catch (e) {
    try { db.exec(`ALTER TABLE youtube_settings ADD COLUMN artists_playlist_id TEXT`); } catch (e2) {}
    db.prepare(`UPDATE youtube_settings SET artists_playlist_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(playlistId);
  }
}

/* ----------------- OAuth URL helpers ----------------- */

function getAuthUrl() {
  if (!CLIENT_ID) throw new Error('YT_CLIENT_ID not set');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  return u.toString();
}

function postForm(urlStr, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const u = new URL(urlStr);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.error_description || parsed.error || `HTTP ${res.statusCode}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function googleApi(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: headers || {}
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, headers: res.headers, body: parsed });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, headers: res.headers, body: data });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ----------------- Token exchange / refresh ----------------- */

async function exchangeCodeForTokens(code) {
  const data = await postForm('https://oauth2.googleapis.com/token', {
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  });
  const expiry_ms = nowMs() + ((data.expires_in || 3600) * 1000) - 60000;
  const row = {
    channel_id: null,
    channel_title: null,
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    scope: data.scope || SCOPES,
    token_type: data.token_type || 'Bearer',
    expiry_ms
  };
  saveOAuthRow(row);
  // Fetch channel info
  try {
    const ch = await googleApi('GET',
      'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
      { Authorization: `Bearer ${data.access_token}` });
    const item = (ch.body && ch.body.items && ch.body.items[0]) || null;
    if (item) {
      row.channel_id = item.id;
      row.channel_title = item.snippet && item.snippet.title;
      saveOAuthRow(row);
    }
  } catch (e) {
    // non-fatal
  }
  return getOAuthRow();
}

async function getValidAccessToken() {
  const row = getOAuthRow();
  if (!row || !row.refresh_token) throw new Error('YouTube is not connected yet.');
  if (row.access_token && row.expiry_ms && row.expiry_ms > nowMs()) {
    return row.access_token;
  }
  const data = await postForm('https://oauth2.googleapis.com/token', {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: row.refresh_token,
    grant_type: 'refresh_token'
  });
  const expiry_ms = nowMs() + ((data.expires_in || 3600) * 1000) - 60000;
  saveOAuthRow({
    channel_id: row.channel_id,
    channel_title: row.channel_title,
    access_token: data.access_token,
    refresh_token: null, // keep existing
    scope: data.scope || row.scope,
    token_type: data.token_type || 'Bearer',
    expiry_ms
  });
  return data.access_token;
}

function isConnected() {
  const row = getOAuthRow();
  return !!(row && row.refresh_token);
}

function getConnectionInfo() {
  const row = getOAuthRow() || {};
  const settings = getSettings();
  return {
    connected: !!row.refresh_token,
    channel_id: row.channel_id || null,
    channel_title: row.channel_title || null,
    updated_at: row.updated_at || null,
    testimonials_playlist_id: settings.testimonials_playlist_id || null,
    artists_playlist_id: settings.artists_playlist_id || null,
    default_visibility: settings.default_visibility || 'unlisted'
  };
}

/* ----------------- Playlist ----------------- */

// Generic: find an existing playlist by title (case-insensitive) on the connected channel,
// or create it. The `saveFn` is called with the resolved/created playlist id so it can be cached.
async function findOrCreatePlaylist(title, description, saveFn) {
  const accessToken = await getValidAccessToken();
  const wanted = String(title || '').trim().toLowerCase();

  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await googleApi('GET', url, { Authorization: `Bearer ${accessToken}` });
    const items = (res.body && res.body.items) || [];
    const found = items.find((p) => (p.snippet && (p.snippet.title || '').toLowerCase() === wanted));
    if (found) {
      if (typeof saveFn === 'function') saveFn(found.id);
      return found.id;
    }
    pageToken = res.body && res.body.nextPageToken;
  } while (pageToken);

  const createBody = JSON.stringify({
    snippet: { title, description: description || '' },
    status: { privacyStatus: 'unlisted' }
  });
  const created = await googleApi('POST',
    'https://www.googleapis.com/youtube/v3/playlists?part=snippet,status',
    {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(createBody)
    },
    createBody
  );
  const playlistId = created.body && created.body.id;
  if (playlistId && typeof saveFn === 'function') saveFn(playlistId);
  return playlistId;
}

async function findOrCreateTestimonialsPlaylist() {
  const settings = getSettings();
  if (settings.testimonials_playlist_id) return settings.testimonials_playlist_id;
  return findOrCreatePlaylist(
    'Testimonials',
    'Testimonies submitted to the Jesus Is My King Movement.',
    setTestimonialsPlaylistId
  );
}

async function findOrCreateArtistsPlaylist() {
  const settings = getSettings();
  if (settings.artists_playlist_id) return settings.artists_playlist_id;
  return findOrCreatePlaylist(
    'Artists',
    'Artist testimony and feature videos for the Jesus Is My King Movement.',
    setArtistsPlaylistId
  );
}

async function addVideoToArtistsPlaylist(videoId) {
  const playlistId = await findOrCreateArtistsPlaylist();
  if (!playlistId) return false;
  const accessToken = await getValidAccessToken();
  const body = JSON.stringify({
    snippet: {
      playlistId,
      resourceId: { kind: 'youtube#video', videoId }
    }
  });
  await googleApi('POST',
    'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet',
    {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  );
  return true;
}

async function addVideoToTestimonialsPlaylist(videoId) {
  const playlistId = await findOrCreateTestimonialsPlaylist();
  if (!playlistId) return false;
  const accessToken = await getValidAccessToken();
  const body = JSON.stringify({
    snippet: {
      playlistId,
      resourceId: { kind: 'youtube#video', videoId }
    }
  });
  await googleApi('POST',
    'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet',
    {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  );
  return true;
}

/* ----------------- Upload ----------------- */

async function uploadVideoFromPath(filePath, opts) {
  const {
    title = 'Testimony',
    description = '',
    privacyStatus = 'unlisted', // 'public' | 'unlisted' | 'private'
    tags = ['testimony', 'jesusismykingmovement']
  } = opts || {};

  const accessToken = await getValidAccessToken();

  const stat = fs.statSync(filePath);
  const metadata = JSON.stringify({
    snippet: { title, description, tags, categoryId: '22' },
    status: { privacyStatus, selfDeclaredMadeForKids: false, embeddable: true }
  });

  // Step 1: start resumable upload session
  const start = await new Promise((resolve, reject) => {
    const u = new URL('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status');
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(metadata),
        'X-Upload-Content-Type': 'video/*',
        'X-Upload-Content-Length': stat.size
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode === 200 && res.headers.location) {
          resolve({ uploadUrl: res.headers.location });
        } else {
          reject(new Error(`YT init failed ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(metadata);
    req.end();
  });

  // Step 2: PUT the file bytes
  const finalRes = await new Promise((resolve, reject) => {
    const u = new URL(start.uploadUrl);
    const req = https.request({
      method: 'PUT',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'video/*',
        'Content-Length': stat.size
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`YT upload failed ${res.statusCode}: ${data}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });

  return finalRes; // contains id, snippet, status
}

async function setVideoPrivacy(videoId, privacyStatus) {
  const accessToken = await getValidAccessToken();
  const body = JSON.stringify({
    id: videoId,
    status: { privacyStatus, embeddable: true, selfDeclaredMadeForKids: false }
  });
  await googleApi('PUT',
    'https://www.googleapis.com/youtube/v3/videos?part=status',
    {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  );
  return true;
}

// Creates a Google Resumable Upload session and returns the one-time upload URL.
// The submitter's browser will PUT the video bytes straight to Google — the server
// never proxies the bytes. The video lands in the connected admin's channel.
//
// opts: { title, description, privacyStatus = 'private', fileName, fileSize, contentType }
// Returns: { uploadUrl }
async function createResumableUploadSession(opts) {
  const {
    title = 'Shared Testimony',
    description = '',
    privacyStatus = 'private',
    fileSize,
    contentType = 'video/*',
    tags = ['testimony', 'jesusismykingmovement', 'sharedtestimony']
  } = opts || {};

  if (!fileSize || !Number.isFinite(Number(fileSize))) {
    throw new Error('fileSize is required');
  }

  const accessToken = await getValidAccessToken();
  const allowed = new Set(['private', 'unlisted', 'public']);
  const safePrivacy = allowed.has(String(privacyStatus).toLowerCase()) ? String(privacyStatus).toLowerCase() : 'private';

  const metadata = JSON.stringify({
    snippet: { title, description, tags, categoryId: '22' },
    status: { privacyStatus: safePrivacy, selfDeclaredMadeForKids: false, embeddable: true }
  });

  return new Promise((resolve, reject) => {
    const u = new URL('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status');
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(metadata),
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(fileSize)
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode === 200 && res.headers.location) {
          resolve({ uploadUrl: res.headers.location, privacy: safePrivacy });
        } else {
          reject(new Error(`YT resumable init failed ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(metadata);
    req.end();
  });
}

async function deleteVideo(videoId) {
  const accessToken = await getValidAccessToken();
  await googleApi('DELETE',
    `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(videoId)}`,
    { Authorization: `Bearer ${accessToken}` }
  );
  return true;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForTokens,
  isConnected,
  getConnectionInfo,
  findOrCreateTestimonialsPlaylist,
  addVideoToTestimonialsPlaylist,
  findOrCreateArtistsPlaylist,
  addVideoToArtistsPlaylist,
  uploadVideoFromPath,
  createResumableUploadSession,
  setVideoPrivacy,
  deleteVideo,
  SCOPES,
  REDIRECT_URI
};
