'use strict';

/**
 * Core admin dashboard glue (drop-in version).
 * - Reads admin key from localStorage (set by inline script in admin.html)
 * - Loads stats (overview)
 * - Loads & saves founder default
 * - Bulk imports item codes
 * - Loads recent audit log
 *
 * Endpoints used (must already exist in your backend):
 *   GET  /api/admin/dashboard
 *   PATCH /api/admin/settings/founder
 *   POST /api/admin/item-codes/import
 *   GET  /api/admin/audit-logs
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
        var j;
        try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: 'Non-JSON response from server' }; }
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = String(v == null ? 0 : v); }
  function setVal(id, v)  { var el = document.getElementById(id); if (el) el.value = v == null ? '' : v; }
  function getVal(id)     { var el = document.getElementById(id); return el ? el.value : ''; }
  function setStatus(id, msg, kind) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'status-line ' + (kind || '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }

  function loadDashboard() {
    if (!key()) return;
    api('GET', '/api/admin/dashboard').then(function (r) {
      var s = (r && r.summary) || r || {};
      setText('statPending',  s.pending_count || s.pending || 0);
      setText('statApproved', s.approved_new_count || s.approved || 0);
      setText('statOwners',   s.active_owners_count || s.owners || 0);
      setText('statAssigned', s.assigned_codes_count || s.assigned || 0);
      setText('statDefault',  s.default_codes_count  || s.default_founder || 0);

      var f = (r && r.founder_default) || (r && r.founder) || {};
      setVal('founderName',    f.display_name);
      setVal('founderVideo',   f.public_video_url);
      setVal('founderQuote',   f.short_quote);
      setVal('founderSummary', f.testimony_summary);
    }).catch(function (e) {
      console.warn('dashboard:', e.message);
    });
  }

  function saveFounder() {
    setStatus('founderStatus', 'Saving...');
    api('PATCH', '/api/admin/settings/founder', {
      display_name:      getVal('founderName'),
      public_video_url:  getVal('founderVideo'),
      short_quote:       getVal('founderQuote'),
      testimony_summary: getVal('founderSummary')
    }).then(function () {
      setStatus('founderStatus', 'Saved.', 'ok');
      loadDashboard();
    }).catch(function (e) { setStatus('founderStatus', e.message, 'err'); });
  }

  function importCodes() {
    var text = getVal('codesImportText') || '';
    var codes = text.split(/[\s,;]+/).map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
    if (!codes.length) { setStatus('importCodesStatus', 'Paste at least one code.', 'err'); return; }
    setStatus('importCodesStatus', 'Importing ' + codes.length + '...');
    api('POST', '/api/admin/item-codes/import', { item_codes: codes }).then(function (r) {
      setStatus('importCodesStatus', 'Imported ' + (r.imported_count || r.imported || codes.length) + ' code(s).', 'ok');
      setVal('codesImportText', '');
      loadDashboard();
    }).catch(function (e) { setStatus('importCodesStatus', e.message, 'err'); });
  }

  function loadAudit() {
    if (!key()) return;
    api('GET', '/api/admin/audit-logs').then(function (r) {
      var rows = (r && r.items) || (Array.isArray(r) ? r : []);
      var el = document.getElementById('auditList');
      if (!el) return;
      if (!rows.length) { el.innerHTML = '<div style="color:#666">No audit entries yet.</div>'; return; }
      el.innerHTML = rows.slice(0, 25).map(function (a) {
        var t = a.created_at || a.timestamp || '';
        return '<div style="border:1px solid #eee;border-radius:10px;padding:8px 10px;margin-bottom:6px;background:#fff">' +
          '<div style="font-weight:600">' + esc(a.action || '') + '</div>' +
          '<div style="font-size:12px;color:#777">' + esc(a.entity_type || '') + ' #' + esc(a.entity_id || '') + ' &middot; ' + esc(t) + '</div>' +
        '</div>';
      }).join('');
    }).catch(function (e) { console.warn('audit:', e.message); });
  }

  function wire() {
    var b;
    if ((b = document.getElementById('saveFounderBtn'))) b.addEventListener('click', saveFounder);
    if ((b = document.getElementById('importCodesBtn'))) b.addEventListener('click', importCodes);
    if ((b = document.getElementById('reloadAuditBtn'))) b.addEventListener('click', loadAudit);
  }

  document.addEventListener('DOMContentLoaded', function () {
    wire();
    loadDashboard();
    loadAudit();
  });
  document.addEventListener('jimk:key-changed', function () { loadDashboard(); loadAudit(); });
  document.addEventListener('jimk:reload-all',  function () { loadDashboard(); loadAudit(); });
})();
