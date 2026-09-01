'use strict';

/**
 * src/services/smsService.js
 *
 * SMS alert to the admin when a new testimony is submitted.
 * Fire-and-forget: failures are logged, never thrown to the caller.
 *
 * MODE A — ntfy push (free, instant lock-screen notification):
 *   NTFY_TOPIC           a hard-to-guess topic name, e.g. jimk-admin-x9k27q
 *                        (anyone who knows the topic can subscribe — treat it like a password)
 *   NTFY_SERVER          default: https://ntfy.sh (or your self-hosted ntfy URL)
 *   NTFY_PRIORITY        default: high (urgent bypasses Do Not Disturb on most phones)
 *   Tap the notification -> opens the admin page (Click header).
 *
 * MODE B — Twilio (recommended, most reliable):
 *   TWILIO_ACCOUNT_SID   from console.twilio.com
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM          your Twilio number, e.g. +15551234567
 *   ADMIN_ALERT_PHONE    your cell, e.g. +15557654321
 *
 * MODE B — Email-to-SMS gateway (free, uses existing DreamHost SMTP):
 *   SMS_GATEWAY_EMAIL    your-number@carrier-gateway, e.g.:
 *     Verizon:  5551234567@vtext.com
 *     AT&T:     5551234567@txt.att.net
 *     T-Mobile: 5551234567@tmomail.net
 *   (Reuses SMTP_HOST / SMTP_USER / SMTP_PASS already set for mail.)
 *
 * If both are configured, Twilio is tried first, gateway is the fallback.
 * If neither is configured, SMS is skipped silently and email still works.
 *
 * Shared env:
 *   ADMIN_DASHBOARD_URL  default: https://www.jesusismykingmovement.com/admin.html
 */

const SITE = (process.env.PUBLIC_SITE_BASE_URL || 'https://www.jesusismykingmovement.com').replace(/\/$/, '');
const ADMIN = (process.env.ADMIN_DASHBOARD_URL || (SITE + '/admin.html')).replace(/\/$/, '');

function buildMessage(intake) {
  const name = String(intake.display_name || 'a visitor').trim();
  const fmt = String(intake.format || '').toUpperCase();
  const link = `${ADMIN}#submission-${encodeURIComponent(intake.id || '')}`;
  // Keep it short — SMS gateways truncate long bodies.
  return `JIMK: New testimony from ${name} (${fmt}). Review: ${link}`;
}

async function sendViaNtfy(message, clickUrl) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return { skipped: true, reason: 'NTFY_TOPIC unset' };
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const priority = process.env.NTFY_PRIORITY || 'high';

  const headers = {
    'Title': 'JIMK — Action needed',
    'Priority': priority,
    'Tags': 'rotating_light'
  };
  if (clickUrl) headers['Click'] = clickUrl;

  const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers,
    body: message
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ntfy HTTP ${res.status}: ${txt.slice(0, 300) || 'unknown'}`);
  }
  return { ok: true, via: 'ntfy' };
}

async function sendViaTwilio(message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const to = process.env.ADMIN_ALERT_PHONE;
  if (!sid || !token || !from || !to) return { skipped: true, reason: 'twilio env incomplete' };

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ From: from, To: to, Body: message }).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio HTTP ${res.status}: ${data.message || 'unknown'}`);
  return { ok: true, sid: data.sid };
}

async function sendViaGateway(message) {
  const to = process.env.SMS_GATEWAY_EMAIL;
  if (!to) return { skipped: true, reason: 'SMS_GATEWAY_EMAIL unset' };

  let nodemailer = null;
  try { nodemailer = require('nodemailer'); }
  catch { return { skipped: true, reason: 'nodemailer unavailable' }; }

  const host = process.env.SMTP_HOST || 'smtp.dreamhost.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')) === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return { skipped: true, reason: 'SMTP creds unset' };

  const t = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  await t.sendMail({
    from: process.env.MAIL_FROM || '"JIMK Alerts" <chris@jesusismykingmovement.com>',
    to,
    subject: 'JIMK',
    text: message
  });
  return { ok: true, via: 'email-to-sms' };
}

async function sendAdminNewSubmissionSMS(intake) {
  const message = buildMessage(intake);
  const SITE2 = (process.env.PUBLIC_SITE_BASE_URL || 'https://www.jesusismykingmovement.com').replace(/\/$/, '');
  const clickUrl = `${(process.env.ADMIN_DASHBOARD_URL || (SITE2 + '/admin.html')).replace(/\/$/, '')}#submission-${encodeURIComponent(intake.id || '')}`;
  try {
    const nt = await sendViaNtfy(message, clickUrl);
    if (nt.ok) { console.log('[smsService] ntfy push sent'); return nt; }

    const tw = await sendViaTwilio(message);
    if (tw.ok) { console.log('[smsService] Twilio SMS sent:', tw.sid); return tw; }

    const gw = await sendViaGateway(message);
    if (gw.ok) { console.log('[smsService] gateway SMS sent'); return gw; }

    console.warn('[smsService] no alert channel configured —', nt.reason, '/', tw.reason, '/', gw.reason);
    return { skipped: true };
  } catch (err) {
    console.error('[smsService] alert send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendAdminNewSubmissionSMS, buildMessage };
