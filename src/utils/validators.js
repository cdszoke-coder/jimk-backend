const { normalizeItemCodes } = require('../services/testimonyService');

function assertRequired(fields, body) {
  const missing = fields.filter(field => {
    const value = body[field];
    return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
  });
  if (missing.length) {
    const err = new Error(`Missing required fields: ${missing.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
}

function maybeString(value) {
  if (value === undefined || value === null) return undefined;
  return String(value).trim();
}

function toEmbedUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';

  try {
    const parsed = new URL(value);
    if (parsed.hostname.includes('youtube.com')) {
      const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?#]+)/);
      if (shortsMatch) return `https://www.youtube.com/embed/${shortsMatch[1]}`;
      const videoId = parsed.searchParams.get('v');
      if (videoId) return `https://www.youtube.com/embed/${videoId}`;
      if (parsed.pathname.startsWith('/embed/')) return value;
    }
    if (parsed.hostname === 'youtu.be') {
      const videoId = parsed.pathname.replace(/^\//, '');
      if (videoId) return `https://www.youtube.com/embed/${videoId}`;
    }
  } catch (error) {
    return value;
  }

  return value;
}

function normalizeSubmissionPayload(body) {
  const itemCodes = normalizeItemCodes(body.item_codes || body.itemCodes || body.linked_item_codes || body.linkedItemCodes || []);
  const publicVideoUrl = maybeString(body.public_video_url || body.publicVideoUrl);
  const embedVideoUrl = maybeString(body.embed_video_url || body.embedVideoUrl) || toEmbedUrl(publicVideoUrl);

  return {
    submitted_name: maybeString(body.submitted_name || body.submittedName || body.display_name || body.displayName),
    submitted_email: maybeString(body.submitted_email || body.submittedEmail || body.email),
    location: maybeString(body.location),
    item_codes: itemCodes,
    public_video_url: publicVideoUrl,
    embed_video_url: embedVideoUrl,
    short_quote: maybeString(body.short_quote || body.shortQuote),
    testimony_summary: maybeString(body.testimony_summary || body.testimonySummary),
    admin_notes: maybeString(body.admin_notes || body.adminNotes)
  };
}

function normalizeOwnerPayload(body) {
  const publicVideoUrl = maybeString(body.public_video_url || body.publicVideoUrl);
  const embedVideoUrl = maybeString(body.embed_video_url || body.embedVideoUrl) || (publicVideoUrl ? toEmbedUrl(publicVideoUrl) : undefined);

  return {
    slug: maybeString(body.slug),
    display_name: maybeString(body.display_name || body.displayName),
    email: maybeString(body.email || body.owner_email || body.ownerEmail),
    location: maybeString(body.location),
    public_video_url: publicVideoUrl,
    embed_video_url: embedVideoUrl,
    short_quote: maybeString(body.short_quote || body.shortQuote),
    testimony_summary: maybeString(body.testimony_summary || body.testimonySummary),
    status: maybeString(body.status)
  };
}

module.exports = {
  assertRequired,
  maybeString,
  toEmbedUrl,
  normalizeSubmissionPayload,
  normalizeOwnerPayload
};