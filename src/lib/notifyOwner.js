'use strict';
// -----------------------------------------------------------------------------
// notifyOwner.js — texts you the moment someone submits a testimony.
//
// Drop-in for the JIMK backend (Node + Express on Render, CommonJS).
// ZERO npm dependencies: uses only Node's built-in `https` module.
//
// Channels (pick with NOTIFY_CHANNEL = auto | twilio | ntfy | pushover):
//   twilio   -> a real SMS to your phone. Needs a Twilio number + US A2P 10DLC
//               (or toll-free) registration. See INSTALL-TEXT-ALERTS.txt.
//   ntfy     -> free push that lands on your phone like a text (ntfy app).
//   pushover -> $4.99 one-time app, push notification to your phone.
//   auto     -> uses whichever channel is fully configured, preferring twilio.
//
// DESIGN RULES (important):
//   * A failed alert must NEVER break a testimony submission. Nothing here throws.
//   * One alert per submission, even if the client retries the request.
//   * Hard ceiling on alerts per 10 minutes so a flood can't bill you.
// -----------------------------------------------------------------------------

const https = require('https');
const crypto = require('crypto');

const CFG = {
  channel: (process.env.NOTIFY_CHANNEL || 'auto').trim().toLowerCase(),
  ownerPhone: (process.env.OWNER_PHONE || '').trim(),

  twilio: {
    sid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
    token: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
    from: (process.env.TWILIO_FROM_NUMBER || '').trim(),
    messagingServiceSid: (process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim(),
  },
  ntfy: {
    server: (process.env.NTFY_SERVER || 'https://ntfy.sh').trim().replace(/\/+$/, ''),
    topic: (process.env.NTFY_TOPIC || '').trim(),
    token: (process.env.NTFY_TOKEN || '').trim(),
  },
  pushover: {
    appToken: (process.env.PUSHOVER_APP_TOKEN || '').trim(),
    userKey: (process.env.PUSHOVER_USER_KEY || '').trim(),
  },

  siteName: (process.env.SITE_NAME || 'Jesus Is My King').trim(),
  // Admin page with the Approve / Reject panel. The alert link adds ?review=<id>
  // so the page opens straight to that one submission.
  alertUrl: (process.env.NOTIFY_ALERT_URL || 'https://www.jesusismykingmovement.com/admin.html').trim(),
  tz: (process.env.NOTIFY_TZ || 'America/New_York').trim(),
  timeoutMs: Number(process.env.NOTIFY_TIMEOUT_MS || 12000),
  maxPerWindow: Number(process.env.NOTIFY_MAX_PER_10MIN || 20),
  windowMs: 10 * 60 * 1000,
  dedupeMs: 15 * 60 * 1000,
};

// Which channel will actually be used, and what is still missing.
function channelState() {
  const t = CFG.twilio, n = CFG.ntfy, p = CFG.pushover;
  const twilioReady = !!(t.sid && t.token && CFG.ownerPhone && (t.from || t.messagingServiceSid));
  const ntfyReady = !!n.topic;
  const pushoverReady = !!(p.appToken && p.userKey);
  const missing = [];
  if (!twilioReady) {
    if (!t.sid) missing.push('TWILIO_ACCOUNT_SID');
    if (!t.token) missing.push('TWILIO_AUTH_TOKEN');
    if (!t.from && !t.messagingServiceSid) missing.push('TWILIO_FROM_NUMBER (or TWILIO_MESSAGING_SERVICE_SID)');
    if (!CFG.ownerPhone) missing.push('OWNER_PHONE');
  }
  if (CFG.channel === 'twilio' && !twilioReady) return { active: null, wanted: 'twilio', twilioReady, ntfyReady, pushoverReady, missing };
  if (CFG.channel === 'ntfy' && !ntfyReady) return { active: null, wanted: 'ntfy', twilioReady, ntfyReady, pushoverReady, missing: ['NTFY_TOPIC'] };
  if (CFG.channel === 'pushover' && !pushoverReady) return { active: null, wanted: 'pushover', twilioReady, ntfyReady, pushoverReady, missing: ['PUSHOVER_APP_TOKEN', 'PUSHOVER_USER_KEY'] };

  let active = null;
  if (CFG.channel === 'auto') active = twilioReady ? 'twilio' : (ntfyReady ? 'ntfy' : (pushoverReady ? 'pushover' : null));
  else active = CFG.channel;
  return { active, wanted: CFG.channel, twilioReady, ntfyReady, pushoverReady, missing };
}

// --- tiny HTTPS helper --------------------------------------------------------
function post(urlStr, { headers = {}, body = '', form = null } = {}) {
  return new Promise((resolve) => {
    let payload = body;
    const h = Object.assign({}, headers);
    if (form) {
      const parts = [];
      for (const k of Object.keys(form)) {
        if (form[k] === undefined || form[k] === null) continue;
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(form[k])));
      }
      payload = parts.join('&');
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    h['Content-Length'] = Buffer.byteLength(payload);

    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, status: 0, body: 'bad url: ' + e.message }); }

    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'POST', headers: h, timeout: CFG.timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (data.length < 4000) data += c; });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (_) {} resolve({ ok: false, status: 0, body: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: e && e.message ? e.message : 'network error' }));
    req.end(payload);
  });
}

// --- channel senders ----------------------------------------------------------
async function sendTwilio(text) {
  const t = CFG.twilio;
  const auth = Buffer.from(t.sid + ':' + t.token).toString('base64');
  const form = { To: CFG.ownerPhone, Body: text };
  if (t.messagingServiceSid) form.MessagingServiceSid = t.messagingServiceSid;
  else form.From = t.from;
  const r = await post(
    'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(t.sid) + '/Messages.json',
    { headers: { Authorization: 'Basic ' + auth }, form }
  );
  return r;
}

async function sendNtfy(text, payload) {
  const n = CFG.ntfy;
  const headers = {
    Title: (payload && payload.title) ? String(payload.title).slice(0, 120) : (CFG.siteName + ' alert'),
    Priority: 'high',
    Tags: 'crown,rotating_light',
  };
  const link = payload && !payload.muted ? reviewUrl(payload) : '';
  if (link) {
    headers.Click = link;                                   // tap the notification -> review page
    headers.Actions = 'view, Approve / Deny, ' + link;     // plus a button
  }
  if (n.token) headers.Authorization = 'Bearer ' + n.token;
  return post(n.server + '/' + encodeURIComponent(n.topic), { headers, body: text });
}

async function sendPushover(text, payload) {
  const p = CFG.pushover;
  return post('https://api.pushover.net/1/messages.json', {
    form: {
      token: p.appToken,
      user: p.userKey,
      title: (payload && payload.title) ? String(payload.title).slice(0, 200) : (CFG.siteName + ' alert'),
      message: text,
      priority: 1,
      url: (payload && !payload.muted) ? reviewUrl(payload) : undefined,
      url_title: 'Approve / Deny',
    },
  });
}

// --- guards -------------------------------------------------------------------
const seen = new Map();   // dedupe key -> timestamp
const hits = [];          // timestamps of sent alerts
let rateWarned = 0;

function prune(now) {
  for (const [k, ts] of seen) if (now - ts > CFG.dedupeMs) seen.delete(k);
  while (hits.length && now - hits[0] > CFG.windowMs) hits.shift();
}

function makeKey(payload) {
  const src = [
    (payload && (payload.submissionId || payload.intakeId || payload.intake_id)) || '',
    (payload && (payload.code || payload.shirtCode)) || '',
    (payload && payload.name) || '',
    (payload && payload.kind) || '',
  ].join('|');
  if (src === '||') return crypto.createHash('sha1').update(JSON.stringify(payload || {})).digest('hex').slice(0, 16);
  return crypto.createHash('sha1').update(src).digest('hex').slice(0, 16);
}

// --- message body -------------------------------------------------------------
function localTime(d) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: CFG.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d || new Date());
  } catch (_) { return (d || new Date()).toISOString(); }
}

function reviewUrl(p) {
  if (!CFG.alertUrl) return '';
  const id = p && (p.submissionId || p.intakeId);
  const sep = CFG.alertUrl.indexOf('?') === -1 ? '?' : '&';
  return CFG.alertUrl + sep + 'review=' + encodeURIComponent(id ? String(id) : 'pending');
}

function formatAlert(p) {
  p = p || {};
  if (p.test) {
    const link = reviewUrl({});
    return CFG.siteName + ' test alert - your testimony alerts are working. ' + localTime() + (link ? '\nAdmin: ' + link : '');
  }

  // Plain ASCII on purpose: one non-GSM character (like an em dash) makes a
  // Twilio SMS cost ~2x more segments.
  const lines = [];
  lines.push((p.headline ? String(p.headline).slice(0, 40) : 'NEW TESTIMONY') + ' - ' + CFG.siteName);
  if (p.name || p.displayName) lines.push('From: ' + String(p.name || p.displayName).slice(0, 60));
  else lines.push('From: (no name given)');
  if (p.kind) lines.push('Type: ' + String(p.kind).slice(0, p.headline ? 90 : 30));
  else if (p.format) lines.push('Type: ' + String(p.format).slice(0, 30));
  const code = p.code || p.shirtCode || p.itemCode;
  if (code) lines.push('Code: ' + String(code).slice(0, 40));
  if (p.feature && p.feature !== 'false') lines.push('Asked to be featured: yes');
  lines.push('When: ' + localTime(p.at ? new Date(p.at) : new Date()));

  let out = lines.join('\n');
  if (out.length > 220) out = out.slice(0, 217) + '...';
  const link = reviewUrl(p);
  // The link is added last and is never cut off.
  if (link) out += '\nApprove/Deny: ' + link;
  return out;
}

// --- public API ---------------------------------------------------------------
/**
 * Send the owner alert. Never throws, never rejects.
 * @returns {Promise<{ok:boolean, channel:string|null, status:number, detail:string, skipped?:string}>}
 */
async function notifyOwner(payload, opts) {
  const quiet = !!(opts && opts.quiet);
  try {
    const now = Date.now();
    prune(now);

    const state = channelState();
    if (!state.active) {
      const msg = 'notifyOwner: no channel configured (missing: ' + (state.missing.join(', ') || 'unknown') + ')';
      if (!quiet) console.warn('[notifyOwner] ' + msg);
      return { ok: false, channel: null, status: 0, detail: msg, skipped: 'not_configured' };
    }

    const key = makeKey(payload);
    if (seen.has(key)) {
      if (!quiet) console.log('[notifyOwner] duplicate submission ignored (' + key + ')');
      return { ok: false, channel: state.active, status: 0, detail: 'duplicate ignored', skipped: 'duplicate' };
    }

    if (hits.length >= CFG.maxPerWindow) {
      if (!quiet) console.warn('[notifyOwner] rate ceiling reached (' + CFG.maxPerWindow + ' per 10 min) — alert suppressed');
      if (rateWarned !== now) {
        rateWarned = now;
        const text = CFG.siteName + ': more than ' + CFG.maxPerWindow + ' testimony alerts in 10 minutes — further texts are muted for now. Check the admin page.';
        try {
          if (state.active === 'twilio') await sendTwilio(text);
          else if (state.active === 'ntfy') await sendNtfy(text, { title: CFG.siteName + ' alerts muted', muted: true });
          else if (state.active === 'pushover') await sendPushover(text, { title: CFG.siteName + ' alerts muted', muted: true });
        } catch (_) {}
      }
      return { ok: false, channel: state.active, status: 0, detail: 'rate limited', skipped: 'rate_limited' };
    }

    // Claim the key BEFORE the network call so a fast retry can't double-send.
    seen.set(key, now);
    hits.push(now);

    const text = formatAlert(payload);
    let r;
    if (state.active === 'twilio') r = await sendTwilio(text);
    else if (state.active === 'ntfy') r = await sendNtfy(text, payload);
    else if (state.active === 'pushover') r = await sendPushover(text, payload);
    else r = { ok: false, status: 0, body: 'unknown channel ' + state.active };

    if (r.ok) {
      console.log('[notifyOwner] alert sent via ' + state.active + ' (' + r.status + ')');
      return { ok: true, channel: state.active, status: r.status, detail: String(r.body).slice(0, 400) };
    }
    console.error('[notifyOwner] alert FAILED via ' + state.active + ' — status ' + r.status + ': ' + String(r.body).slice(0, 400));
    return { ok: false, channel: state.active, status: r.status, detail: String(r.body).slice(0, 400) };
  } catch (err) {
    // Absolute last resort: never let an alert break the submission.
    try { console.error('[notifyOwner] unexpected error: ' + (err && err.message)); } catch (_) {}
    return { ok: false, channel: null, status: 0, detail: (err && err.message) || 'error' };
  }
}

// Fire-and-forget wrapper for request handlers.
function notifyOwnerSoon(payload) {
  notifyOwner(payload).catch(() => {});
}

/**
 * Auto-hook: mount ONCE near the top of server.js (after the body parsers,
 * before your routes). It watches for successful POSTs to the testimony
 * endpoints and sends the alert for you — no route edits needed.
 *
 *   app.use(require('./src/lib/notifyOwner').notifyOwnerMiddleware());
 */
function notifyOwnerMiddleware(options) {
  const o = options || {};
  const SUBMIT = o.submitPath || '/api/public/testimony';
  const INIT = o.initPath || '/api/public/testimony/youtube-init';
  const FINALIZE = o.finalizePath || '/api/public/testimony/youtube-finalize';

  // The video flow sends the person's details on youtube-init, but finalize
  // only carries { intake_id, video_id }. Remember init details by intake_id
  // so the finalize alert can still say who it is from.
  const pending = new Map();   // intake_id -> { details, ts }
  const PENDING_MS = 6 * 60 * 60 * 1000;

  function pick(b) {
    b = b || {};
    const fmt = String(b.format || b.kind || b.media_type || b.type || '').trim();
    return {
      name: b.display_name || b.displayName || b.name || b.full_name || '',
      kind: fmt ? fmt.charAt(0).toUpperCase() + fmt.slice(1) : '',
      code: b.qr_code || b.item_code || b.itemCode || b.shirt_code || b.shirtCode || b.code || '',
      intakeId: b.intake_id || b.intakeId || '',
      submissionId: '',
      feature: b.wants_feature || b.feature_me || b.featureMe || b.feature || '',
    };
  }

  // Common shapes: {id}, {submission_id}, {intake_id}, {item:{id}}, {submission:{id}}
  function idFrom(data) {
    if (!data || typeof data !== 'object') return '';
    const c = [data.submission_id, data.submissionId, data.id, data.intake_id,
      data.item && data.item.id, data.submission && data.submission.id,
      data.intake && data.intake.id, data.data && data.data.id];
    for (const v of c) if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    return '';
  }

  return function notifyOwnerHook(req, res, next) {
    try {
      const method = (req.method || '').toUpperCase();
      const path = (req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
      if (method !== 'POST') return next();

      if (path === INIT) {
        // Capture intake_id from the JSON response.
        const origJson = res.json.bind(res);
        res.json = function (data) {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300 && data && data.intake_id) {
              const now = Date.now();
              for (const [k, v] of pending) if (now - v.ts > PENDING_MS) pending.delete(k);
              pending.set(String(data.intake_id), { details: pick(req.body), ts: now });
            }
          } catch (_) {}
          return origJson(data);
        };
        return next();
      }

      if (path === SUBMIT || path === FINALIZE) {
        // Peek at the JSON reply to learn the new submission's id (for the review link).
        let replyId = '';
        const origJson = res.json.bind(res);
        res.json = function (data) {
          try { replyId = idFrom(data); } catch (_) {}
          return origJson(data);
        };
        res.on('finish', function () {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) return;   // rejected submissions don't alert
            let d = pick(req.body);
            if (path === FINALIZE) {
              const saved = d.intakeId && pending.get(String(d.intakeId));
              if (saved) { d = Object.assign({}, saved.details, { intakeId: d.intakeId }); pending.delete(String(d.intakeId)); }
              d.kind = 'Video';
            }
            d.submissionId = replyId || d.intakeId || '';
            notifyOwner(d).catch(function () {});
          } catch (_) {}
        });
      }
    } catch (_) {}
    next();
  };
}

module.exports = {
  notifyOwner,
  reviewUrl,
  notifyOwnerSoon,
  notifyOwnerMiddleware,
  formatAlert,
  channelState,
  config: CFG,
};
