const path = require('path');
const fs = require('fs');
const { getSetting, setSetting } = require('./testimonyService');
const { toEmbedUrl } = require('../utils/validators');

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseArtworkJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function stringifyArtworkJson(list = []) {
  return JSON.stringify(Array.from(new Set((Array.isArray(list) ? list : [list]).map(x => String(x || '').trim()).filter(Boolean))));
}

function normalizePublicUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return value;
}

function createAbsoluteAssetUrl(assetUrl, siteBaseUrl) {
  const value = String(assetUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const site = String(siteBaseUrl || '').replace(/\/$/, '');
  if (!site) return value;
  return `${site}${value.startsWith('/') ? '' : '/'}${value}`;
}

function getArtistSiteSettings(db) {
  return {
    site_base_url: getSetting(db, 'site_base_url', 'https://www.jesusismykingmovement.com'),
    artist_page_path: getSetting(db, 'artist_page_path', '/artist.html'),
    artist_directory_path: getSetting(db, 'artist_directory_path', '/artists.html')
  };
}

function updateArtistSiteSettings(db, payload = {}) {
  const current = getArtistSiteSettings(db);
  const next = {
    site_base_url: payload.site_base_url ?? current.site_base_url,
    artist_page_path: payload.artist_page_path ?? current.artist_page_path,
    artist_directory_path: payload.artist_directory_path ?? current.artist_directory_path
  };
  setSetting(db, 'site_base_url', next.site_base_url);
  setSetting(db, 'artist_page_path', next.artist_page_path);
  setSetting(db, 'artist_directory_path', next.artist_directory_path);
  return getArtistSiteSettings(db);
}

function serializeArtist(row, options = {}) {
  if (!row) return null;
  const siteBaseUrl = options.site_base_url || '';
  const artworkUrls = parseArtworkJson(row.artwork_json);
  const qrTarget = `${String(options.artist_page_path || '/artist.html')}${row.slug ? `?artist=${encodeURIComponent(row.slug)}` : ''}`;
  const portraitImageUrl = row.portrait_image_url || '';
  const heroSource = row.hero_source === 'portrait' ? 'portrait' : 'artwork';
  const effectiveHero = heroSource === 'portrait'
    ? (portraitImageUrl || row.hero_image_url || artworkUrls[0] || '')
    : (row.hero_image_url || artworkUrls[0] || portraitImageUrl || '');
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    location: row.location || '',
    medium: row.medium || '',
    joined_label: row.joined_label || '',
    short_quote: row.short_quote || '',
    bio: row.bio || '',
    testimony_summary: row.testimony_summary || '',
    public_video_url: row.public_video_url || '',
    embed_video_url: row.embed_video_url || '',
    hero_image_url: row.hero_image_url || '',
    portrait_image_url: portraitImageUrl,
    hero_source: heroSource,
    effective_hero_url: effectiveHero,
    artwork_urls: artworkUrls,
    artwork_count: artworkUrls.length,
    status: row.status,
    qr_path: qrTarget,
    qr_url: siteBaseUrl ? `${String(siteBaseUrl).replace(/\/$/, '')}${qrTarget}` : qrTarget,
    created_at: row.created_at,
    updated_at: row.updated_at,
    hero_image_absolute_url: createAbsoluteAssetUrl(effectiveHero, siteBaseUrl),
    portrait_image_absolute_url: createAbsoluteAssetUrl(portraitImageUrl, siteBaseUrl),
    artwork_absolute_urls: artworkUrls.map(url => createAbsoluteAssetUrl(url, siteBaseUrl))
  };
}

function buildUniqueArtistSlug(db, proposed) {
  const base = slugify(proposed || 'artist');
  let slug = base || 'artist';
  let counter = 2;
  while (db.prepare('SELECT id FROM artist_profiles WHERE slug = ?').get(slug)) {
    slug = `${base || 'artist'}-${counter++}`;
  }
  return slug;
}

function getArtistById(db, artistId) {
  const row = db.prepare('SELECT * FROM artist_profiles WHERE id = ?').get(Number(artistId));
  return row ? serializeArtist(row, getArtistSiteSettings(db)) : null;
}

function getArtistBySlug(db, slug) {
  const row = db.prepare('SELECT * FROM artist_profiles WHERE slug = ? AND status = ?').get(String(slug || ''), 'active');
  return row ? serializeArtist(row, getArtistSiteSettings(db)) : null;
}

function listArtists(db, filters = {}) {
  const clauses = [];
  const values = [];
  if (filters.status && filters.status !== 'all') {
    clauses.push('status = ?');
    values.push(filters.status);
  }
  if (filters.query) {
    const q = `%${String(filters.query).trim()}%`;
    clauses.push('(display_name LIKE ? OR slug LIKE ? OR IFNULL(location, "") LIKE ? OR IFNULL(medium, "") LIKE ?)');
    values.push(q, q, q, q);
  }
  const sql = `
    SELECT *
    FROM artist_profiles
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, id DESC
    LIMIT ? OFFSET ?
  `;
  const limit = Math.min(100, Math.max(1, Number(filters.limit || 100)));
  const offset = Math.max(0, Number(filters.offset || 0));
  return db.prepare(sql).all(...values, limit, offset).map(row => serializeArtist(row, getArtistSiteSettings(db)));
}

function searchArtistsPaginated(db, filters = {}) {
  const clauses = [];
  const values = [];
  if (filters.status && filters.status !== 'all') {
    clauses.push('status = ?');
    values.push(filters.status);
  }
  if (filters.query) {
    const q = `%${String(filters.query).trim()}%`;
    clauses.push('(display_name LIKE ? OR slug LIKE ? OR IFNULL(location, "") LIKE ? OR IFNULL(medium, "") LIKE ?)');
    values.push(q, q, q, q);
  }
  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(filters.page_size || 20)));
  const offset = (page - 1) * pageSize;
  const total = db.prepare(`SELECT COUNT(*) AS count FROM artist_profiles ${whereClause}`).get(...values).count;
  const rows = db.prepare(`
    SELECT *
    FROM artist_profiles
    ${whereClause}
    ORDER BY updated_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...values, pageSize, offset);
  const items = rows.map(row => serializeArtist(row, getArtistSiteSettings(db)));
  return {
    items,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
    has_prev: page > 1,
    has_next: page < Math.max(1, Math.ceil(total / pageSize))
  };
}

function createArtist(db, payload = {}) {
  if (!payload.display_name) throw new Error('display_name is required');
  const slug = buildUniqueArtistSlug(db, payload.slug || payload.display_name);
  const publicVideoUrl = normalizePublicUrl(payload.public_video_url);
  const embedVideoUrl = String(payload.embed_video_url || '').trim() || toEmbedUrl(publicVideoUrl);
  const artworkJson = stringifyArtworkJson(payload.artwork_urls || []);
  const heroImageUrl = String(payload.hero_image_url || '').trim() || parseArtworkJson(artworkJson)[0] || '';
  const portraitImageUrl = String(payload.portrait_image_url || '').trim() || '';
  const heroSource = payload.hero_source === 'portrait' ? 'portrait' : 'artwork';
  const result = db.prepare(`
    INSERT INTO artist_profiles (
      slug, display_name, location, medium, joined_label, short_quote, bio,
      testimony_summary, public_video_url, embed_video_url, hero_image_url,
      portrait_image_url, hero_source, artwork_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slug,
    payload.display_name,
    payload.location || null,
    payload.medium || null,
    payload.joined_label || null,
    payload.short_quote || null,
    payload.bio || null,
    payload.testimony_summary || null,
    publicVideoUrl || null,
    embedVideoUrl || null,
    heroImageUrl || null,
    portraitImageUrl || null,
    heroSource,
    artworkJson,
    payload.status || 'active'
  );
  return getArtistById(db, result.lastInsertRowid);
}

function updateArtist(db, artistId, payload = {}) {
  const existing = db.prepare('SELECT * FROM artist_profiles WHERE id = ?').get(Number(artistId));
  if (!existing) throw new Error('Artist not found');
  let slug = existing.slug;
  if (payload.slug && payload.slug !== existing.slug) {
    const proposed = slugify(payload.slug);
    const match = db.prepare('SELECT id FROM artist_profiles WHERE slug = ?').get(proposed);
    if (match && match.id !== Number(artistId)) throw new Error('Slug already in use');
    slug = proposed;
  }
  const nextArtworkUrls = payload.artwork_urls ? Array.from(new Set(payload.artwork_urls.map(x => String(x || '').trim()).filter(Boolean))) : parseArtworkJson(existing.artwork_json);
  const publicVideoUrl = payload.public_video_url !== undefined ? normalizePublicUrl(payload.public_video_url) : (existing.public_video_url || '');
  const embedVideoUrl = payload.embed_video_url !== undefined
    ? (String(payload.embed_video_url || '').trim() || toEmbedUrl(publicVideoUrl))
    : (existing.embed_video_url || toEmbedUrl(publicVideoUrl));
  const heroImageUrl = payload.hero_image_url !== undefined
    ? String(payload.hero_image_url || '').trim()
    : (existing.hero_image_url || nextArtworkUrls[0] || '');
  const portraitImageUrl = payload.portrait_image_url !== undefined
    ? String(payload.portrait_image_url || '').trim()
    : (existing.portrait_image_url || '');
  const heroSource = payload.hero_source !== undefined
    ? (payload.hero_source === 'portrait' ? 'portrait' : 'artwork')
    : (existing.hero_source === 'portrait' ? 'portrait' : 'artwork');
  db.prepare(`
    UPDATE artist_profiles SET
      slug = ?,
      display_name = ?,
      location = ?,
      medium = ?,
      joined_label = ?,
      short_quote = ?,
      bio = ?,
      testimony_summary = ?,
      public_video_url = ?,
      embed_video_url = ?,
      hero_image_url = ?,
      portrait_image_url = ?,
      hero_source = ?,
      artwork_json = ?,
      status = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    slug,
    payload.display_name ?? existing.display_name,
    payload.location ?? existing.location,
    payload.medium ?? existing.medium,
    payload.joined_label ?? existing.joined_label,
    payload.short_quote ?? existing.short_quote,
    payload.bio ?? existing.bio,
    payload.testimony_summary ?? existing.testimony_summary,
    publicVideoUrl || null,
    embedVideoUrl || null,
    heroImageUrl || null,
    portraitImageUrl || null,
    heroSource,
    stringifyArtworkJson(nextArtworkUrls),
    payload.status ?? existing.status,
    Number(artistId)
  );
  return getArtistById(db, artistId);
}

function addArtistArtwork(db, artistId, fileUrls = [], options = {}) {
  const existing = db.prepare('SELECT * FROM artist_profiles WHERE id = ?').get(Number(artistId));
  if (!existing) throw new Error('Artist not found');
  const current = parseArtworkJson(existing.artwork_json);
  const next = Array.from(new Set([...current, ...fileUrls.map(x => String(x || '').trim()).filter(Boolean)]));
  const heroImageUrl = options.set_as_hero ? (fileUrls[0] || existing.hero_image_url || '') : (existing.hero_image_url || fileUrls[0] || '');
  return updateArtist(db, artistId, {
    artwork_urls: next,
    hero_image_url: heroImageUrl
  });
}

function getPublicArtistsDirectory(db) {
  const settings = getArtistSiteSettings(db);
  return {
    site_base_url: settings.site_base_url,
    artist_page_path: settings.artist_page_path,
    artist_directory_path: settings.artist_directory_path,
    artists: listArtists(db, { status: 'active', limit: 50, offset: 0 })
  };
}

function ensureArtistUploadDir(baseUploadsDir) {
  const uploadDir = path.join(baseUploadsDir, 'artists');
  fs.mkdirSync(uploadDir, { recursive: true });
  return uploadDir;
}

module.exports = {
  slugify,
  parseArtworkJson,
  stringifyArtworkJson,
  getArtistSiteSettings,
  updateArtistSiteSettings,
  getArtistById,
  getArtistBySlug,
  listArtists,
  searchArtistsPaginated,
  createArtist,
  updateArtist,
  addArtistArtwork,
  getPublicArtistsDirectory,
  ensureArtistUploadDir,
  createAbsoluteAssetUrl
};