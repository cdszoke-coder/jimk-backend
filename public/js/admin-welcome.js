'use strict';

/**
 * Admin: Movement Welcome Video panel.
 * Replaces the older "Founder Default" labels with the new Welcome Video
 * concept. Stored in the same underlying setting rows so QR resolution
 * keeps working without a schema change.
 *
 * Required DOM (added by admin-welcome-panel.html):
 *   #welcomeTitleInput
 *   #welcomeCtaInput
 *   #welcomeVideoUrlInput
 *   #welcomeEmbedUrlInput
 *   #saveWelcomeBtn
 *   #welcomeStatus
 */

(function () {
  function key() { return localStorage.getItem('jimk_admin_key') || ''; }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: Object.assign(
        { 'x-admin-key': key() },
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var j; try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: 'Non-JSON response' }; }
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function setVal(id, v) { var el = document.getElementById(id); if (el) el.value = (v == null ? '' : v); }
  function getVal(id)    { var el = document.getElementById(id); return el ? el.value : ''; }
  function setStatus(msg, kind) {
    var el = document.getElementById('welcomeStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? '#b00020' : (kind === 'ok' ? '#0a7d2c' : '#333');
  }

  function load() {
    if (!key()) return;
    fetch('/api/public/welcome').then(function (r) { return r.json(); }).then(function (j) {
      setVal('welcomeTitleInput',    j.title);
      setVal('welcomeCtaInput',      j.short_cta);
      setVal('welcomeVideoUrlInput', j.public_video_url);
      setVal('welcomeEmbedUrlInput', j.embed_video_url);
    }).catch(function () {});
  }

  function save() {
    setStatus('Saving...');
    api('PATCH', '/api/admin/settings/welcome', {
      title:            getVal('welcomeTitleInput'),
      short_cta:        getVal('welcomeCtaInput'),
      public_video_url: getVal('welcomeVideoUrlInput'),
      embed_video_url:  getVal('welcomeEmbedUrlInput') || undefined
    }).then(function () {
      setStatus('Saved. The welcome video now updates everywhere.', 'ok');
      load();
    }).catch(function (e) { setStatus(e.message, 'err'); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('saveWelcomeBtn');
    if (b) b.addEventListener('click', save);
    load();
  });
  document.addEventListener('jimk:key-changed', load);
  document.addEventListener('jimk:reload-all', load);
})();
