// src/services/mailService.js
// Transactional email for JESUS IS MY KING MOVEMENT.
//
// Three send helpers:
//   sendAdminNewSubmission(intake) — chris@ gets a summary with an admin review link
//   sendThankYou(intake)           — submitter receives a thank-you (if they provided email)
//   sendDecision({ intake, decision, owner, qrCodes }) — submitter receives approval/rejection
//
// Required env vars (set on Render — never check secrets into the repo):
//   SMTP_HOST              default: smtp.dreamhost.com
//   SMTP_PORT              default: 465
//   SMTP_SECURE            default: true (SSL on 465)
//   SMTP_USER              chris@jesusismykingmovement.com
//   SMTP_PASS              mailbox password (DreamHost panel)
//   MAIL_FROM              default: '"Jesus Is My King Movement" <chris@jesusismykingmovement.com>'
//   ADMIN_ALERT_EMAIL      default: chris@jesusismykingmovement.com
//   PUBLIC_SITE_BASE_URL   default: https://www.jesusismykingmovement.com
//   ADMIN_DASHBOARD_URL    default: https://www.jesusismykingmovement.com/admin.html

'use strict';

let nodemailer = null;
let QRCode = null;
try { nodemailer = require('nodemailer'); }
catch (e) { console.warn('[mailService] nodemailer not installed:', e.message); }
try { QRCode = require('qrcode'); }
catch (e) { console.warn('[mailService] qrcode not installed:', e.message); }

const SITE = (process.env.PUBLIC_SITE_BASE_URL || 'https://www.jesusismykingmovement.com').replace(/\/$/, '');
const ADMIN = (process.env.ADMIN_DASHBOARD_URL || (SITE + '/admin.html')).replace(/\/$/, '');
const FROM = process.env.MAIL_FROM || '"Jesus Is My King Movement" <chris@jesusismykingmovement.com>';
const ADMIN_TO = process.env.ADMIN_ALERT_EMAIL || 'chris@jesusismykingmovement.com';

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!nodemailer) return null;
  const host = process.env.SMTP_HOST || 'smtp.dreamhost.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')) === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    console.warn('[mailService] SMTP_USER / SMTP_PASS not set — mail send disabled');
    return null;
  }
  transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  return transporter;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function plainText(html) {
  return String(html).replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim();
}

function emailLayout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#faf6ff;font-family:Inter,Arial,sans-serif;color:#2a2440;">
  <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(42,17,64,0.08);">
    <div style="background:linear-gradient(135deg,#2a1140,#5a2a82);color:#fff;padding:26px 28px;">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#b8860b;font-weight:700;">JESUS IS MY KING MOVEMENT</div>
      <div style="font-family:Cinzel,Georgia,serif;font-size:22px;margin-top:6px;">${esc(title)}</div>
    </div>
    <div style="padding:24px 28px;line-height:1.6;font-size:15px;">
      ${bodyHtml}
    </div>
    <div style="background:#faf6ff;padding:16px 28px;font-size:12px;color:#6a6480;text-align:center;border-top:1px solid #eadcf3;">
      Jesus Is My King Movement &middot; <a href="${esc(SITE)}" style="color:#5a2a82;">jesusismykingmovement.com</a>
    </div>
  </div></body></html>`;
}

// ----- Helper: build a story URL for an owner profile -----
function storyUrlFor(owner) {
  if (!owner) return SITE;
  if (owner.slug) return `${SITE}/story.html?id=${encodeURIComponent(owner.slug)}`;
  return SITE;
}

// ----- 1. Admin notification on new submission -----
async function sendAdminNewSubmission(intake) {
  const t = getTransporter();
  if (!t) return { skipped: true, reason: 'transporter unavailable' };

  const reviewLink = `${ADMIN}#submission-${encodeURIComponent(intake.id || '')}`;
  const lines = [
    `<p>A new testimony has been submitted and is waiting for review.</p>`,
    `<table style="width:100%;border-collapse:collapse;margin:14px 0;">`,
    rowHtml('Name', intake.display_name),
    rowHtml('Location', intake.location),
    rowHtml('Format', String(intake.format || '').toUpperCase()),
    rowHtml('How they found us', intake.discovery_source),
    intake.qr_code ? rowHtml('QR code on intake', intake.qr_code) : '',
    intake.contact_email ? rowHtml('Submitter email', intake.contact_email) : rowHtml('Submitter email', '(not provided)'),
    intake.short_quote ? rowHtml('Headline', intake.short_quote) : '',
    intake.video_link_url ? rowHtml('Video link', `<a href="${esc(intake.video_link_url)}">${esc(intake.video_link_url)}</a>`) : '',
    intake.written_body ? rowHtml('Written body', `<em>${esc(String(intake.written_body).slice(0, 280))}${intake.written_body.length > 280 ? '…' : ''}</em>`) : '',
    intake.photo_caption ? rowHtml('Photo caption', intake.photo_caption) : '',
    `</table>`,
    `<p style="text-align:center;margin:22px 0;"><a href="${esc(reviewLink)}" style="display:inline-block;background:#5a2a82;color:#fff;padding:12px 26px;border-radius:999px;font-weight:700;text-decoration:none;">Open Admin Dashboard</a></p>`,
    `<p style="font-size:13px;color:#6a6480;">Or copy this link: <a href="${esc(reviewLink)}">${esc(reviewLink)}</a></p>`
  ];
  const html = emailLayout('New Testimony for Review', lines.join(''));

  try {
    await t.sendMail({
      from: FROM,
      to: ADMIN_TO,
      subject: `New testimony from ${intake.display_name || 'a visitor'} (${String(intake.format || '').toUpperCase()})`,
      html, text: plainText(html)
    });
    return { ok: true };
  } catch (err) {
    console.error('[mailService] admin notify failed:', err.message);
    return { ok: false, error: err.message };
  }
}

function rowHtml(label, value) {
  if (value == null || value === '') return '';
  return `<tr><td style="padding:6px 0;color:#6a6480;width:160px;vertical-align:top;">${esc(label)}</td><td style="padding:6px 0;color:#2a1140;font-weight:600;">${value}</td></tr>`;
}

// ----- 2. Submitter thank-you -----
async function sendThankYou(intake) {
  const to = (intake.contact_email || '').trim();
  if (!to) return { skipped: true, reason: 'no email on intake' };
  const t = getTransporter();
  if (!t) return { skipped: true, reason: 'transporter unavailable' };

  // Codes attached so far. For a new testimony this is just intake.qr_code (if any).
  // For a CLAIM REQUEST it's the new code being claimed. We list them so the
  // submitter has a record of the identifier(s) attached to their story.
  const codesSoFar = [];
  if (intake.qr_code) codesSoFar.push(String(intake.qr_code).trim().toUpperCase());

  const isClaim = /^\[CLAIM REQUEST\]/i.test(String(intake.admin_notes || ''));
  const introCopy = isClaim
    ? `Thank you for asking us to link a new shirt to your existing testimony on the JESUS IS MY KING MOVEMENT wall. Your request is queued for review.`
    : `Thank you for sharing your testimony with the JESUS IS MY KING MOVEMENT. We received your submission and it's queued for review.`;

  const codesBlock = codesSoFar.length ? `
    <p style="margin-top:18px;"><strong>Shirt code${codesSoFar.length > 1 ? 's' : ''} on your request:</strong></p>
    <ul style="padding-left:20px;margin:6px 0 0;">
      ${codesSoFar.map(c => `<li style="font-family:ui-monospace,monospace;color:#5a2a82;font-weight:700;">${esc(c)}</li>`).join('')}
    </ul>
    <p style="font-size:13px;color:#6a6480;margin-top:6px;">Save this code somewhere safe. You can use it any time to link a new shirt to your testimony.</p>
  ` : '';

  const body = `
    <p>Hi ${esc(intake.display_name || 'friend')},</p>
    <p>${introCopy}</p>
    <p>Once it's been reviewed, you'll get one more email from us — letting you know whether your story is going on the public wall, along with a shareable link and (if your testimony is linked to a shirt) a QR code you can post to socials.</p>
    ${codesBlock}
    <p style="margin:22px 0;text-align:center;">
      <a href="${esc(SITE + '/movement.html')}" style="display:inline-block;background:#5a2a82;color:#fff;padding:10px 22px;border-radius:999px;font-weight:700;text-decoration:none;">Visit the Wall</a>
    </p>
    <p style="color:#6a6480;font-size:13px;">If you didn't submit a testimony, please ignore this email — nothing else happens.</p>
  `;
  const html = emailLayout('Thank You — We Received Your Testimony', body);

  try {
    await t.sendMail({
      from: FROM, to, replyTo: ADMIN_TO,
      subject: 'Thank you — your testimony has been received',
      html, text: plainText(html)
    });
    return { ok: true };
  } catch (err) {
    console.error('[mailService] thank-you failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ----- 3. Decision email (approved or rejected) -----
async function sendDecision({ intake, decision, owner, qrCodes }) {
  const to = (intake && intake.contact_email || '').trim();
  if (!to) return { skipped: true, reason: 'no email on intake' };
  const t = getTransporter();
  if (!t) return { skipped: true, reason: 'transporter unavailable' };

  const approved = String(decision || '').toLowerCase() === 'approved';
  const rejected = String(decision || '').toLowerCase() === 'rejected';
  if (!approved && !rejected) return { skipped: true, reason: 'unknown decision' };

  if (approved) {
    const storyUrl = storyUrlFor(owner);
    const codes = Array.isArray(qrCodes) ? qrCodes.filter(Boolean) : [];
    const attachments = [];

    let qrSectionHtml = '';
    if (codes.length && QRCode) {
      qrSectionHtml += `<p style="margin-top:22px;"><strong>Your shareable QR code${codes.length > 1 ? 's' : ''}:</strong></p>`;
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        const target = `${SITE}/story.html?shirt=${encodeURIComponent(code)}`;
        try {
          const dataUrl = await QRCode.toDataURL(target, { width: 360, margin: 2, color: { dark: '#2a1140', light: '#ffffff' } });
          const cid = `qrcode-${i}@jimk`;
          const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
          attachments.push({ filename: `${code}.png`, content: Buffer.from(base64, 'base64'), cid });
          qrSectionHtml += `<div style="text-align:center;margin:14px 0;padding:14px;background:#faf6ff;border:1px solid #e7ddf5;border-radius:12px;">
            <img src="cid:${cid}" alt="QR code ${esc(code)}" style="width:200px;height:200px;display:block;margin:0 auto 8px;" />
            <div style="font-family:ui-monospace,monospace;font-weight:700;color:#5a2a82;font-size:13px;">${esc(code)}</div>
            <div style="font-size:12px;color:#6a6480;margin-top:4px;">Anyone who scans this lands on your testimony.</div>
          </div>`;
        } catch (qrErr) {
          console.warn('[mailService] QR generation failed for', code, qrErr.message);
        }
      }
    }

    const shareCopy = `My testimony is on the Jesus Is My King Movement wall — check it out: ${storyUrl}`;
    const codesListHtml = codes.length ? `
      <p style="margin-top:18px;"><strong>All shirt codes attached to your testimony:</strong></p>
      <ul style="padding-left:20px;margin:6px 0 0;">
        ${codes.map(c => `<li style="font-family:ui-monospace,monospace;color:#5a2a82;font-weight:700;">${esc(c)}</li>`).join('')}
      </ul>
      <p style="font-size:13px;color:#6a6480;margin-top:6px;">Keep these somewhere safe — you can use any of them to link another shirt to your testimony later.</p>
    ` : '';
    const body = `
      <p>Hi ${esc(intake.display_name || 'friend')},</p>
      <p><strong>Your testimony has been approved and is now live on the wall.</strong> All glory to God for the story He's writing through you.</p>
      <p style="margin:22px 0;text-align:center;">
        <a href="${esc(storyUrl)}" style="display:inline-block;background:#5a2a82;color:#fff;padding:12px 26px;border-radius:999px;font-weight:700;text-decoration:none;">View Your Story</a>
      </p>
      <p><strong>Share your shareable link:</strong></p>
      <p style="background:#faf6ff;padding:10px 14px;border-radius:8px;font-family:ui-monospace,monospace;font-size:13px;word-break:break-all;"><a href="${esc(storyUrl)}">${esc(storyUrl)}</a></p>
      <p style="font-size:13px;color:#6a6480;">Copy-and-paste for socials:<br><em>"${esc(shareCopy)}"</em></p>
      ${codesListHtml}
      ${qrSectionHtml}
      <p style="margin-top:22px;">Thank you for joining the movement. Every story matters.</p>
    `;
    const html = emailLayout('Your Testimony Is Live', body);

    try {
      await t.sendMail({
        from: FROM, to, replyTo: ADMIN_TO,
        subject: 'Your testimony is live on the wall',
        html, text: plainText(html),
        attachments
      });
      return { ok: true };
    } catch (err) {
      console.error('[mailService] approval email failed:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // Rejection
  const body = `
    <p>Hi ${esc(intake.display_name || 'friend')},</p>
    <p>Thank you for sharing your story with us. After review, we're not going to publish this submission on the public wall right now.</p>
    <p>This isn't a judgment of your faith or your story — sometimes a submission needs a small adjustment, or our wall already covers a similar testimony. You're welcome to submit again at any time, and if you have questions, just reply to this email.</p>
    <p style="margin:22px 0;text-align:center;">
      <a href="${esc(SITE + '/testimony.html')}" style="display:inline-block;background:#5a2a82;color:#fff;padding:10px 22px;border-radius:999px;font-weight:700;text-decoration:none;">Submit Again</a>
    </p>
    <p style="color:#6a6480;font-size:13px;">All glory to God. Keep running the race.</p>
  `;
  const html = emailLayout('A note from the movement', body);

  try {
    await t.sendMail({
      from: FROM, to, replyTo: ADMIN_TO,
      subject: 'A note from the JESUS IS MY KING MOVEMENT',
      html, text: plainText(html)
    });
    return { ok: true };
  } catch (err) {
    console.error('[mailService] rejection email failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendAdminNewSubmission,
  sendThankYou,
  sendDecision
};
