'use strict';

/**
 * Admin UI: link an approved YouTube testimony to one or more QR item codes,
 * and optionally reuse the submitter's existing approved video (so multiple
 * shirts share the same video).
 *
 * Required DOM (added by admin-youtube-link-panel.html):
 *   #ytLinkSubId            (hidden input — current submission id, set by admin code when "Approve & link" is clicked)
 *   #ytLinkOpenBtn          (button on each submission card -- handled inline by admin-youtube.js, see notes)
 *   #ytLinkPanel            (hidden modal/section)
 *   #ytLinkSummary
 *   #ytLinkReuseSelect      (<select> of existing owner videos for this submitter)
 *   #ytLinkUseReuse         (checkbox: use selected existing video instead of new one)
 *   #ytLinkMakePublic       (checkbox)
 *   #ytLinkCodeList         (container — checkbox per item code)
 *   #ytLinkCodeFilter       (text input to filter codes)
 *   #ytLinkNotes            (textarea)
 *   #ytLinkConfirmBtn       (button)
 *   #ytLinkCloseBtn         (button)
 *   #ytLinkStatus
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
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }
  function setStatus(msg, kind) {
    var el = document.getElementById('ytLinkStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? '#b00020' : (kind === 'ok' ? '#0a7d2c' : '#333');
  }

  function show(panel, on) { panel.style.display = on ? '' : 'none'; }

  function openLinkPanel(submissionId) {
    var panel = document.getElementById('ytLinkPanel');
    if (!panel) return;
    document.getElementById('ytLinkSubId').value = submissionId;
    setStatus('Loading...', '');
    show(panel, true);

    api('GET', '/api/admin/youtube/testimonies/' + encodeURIComponent(submissionId) + '/approve-options')
      .then(function (data) {
        renderOptions(data);
        setStatus('', '');
      })
      .catch(function (e) { setStatus(e.message, 'err'); });
  }

  function renderOptions(data) {
    var sub = data.submission || {};
    var sum = document.getElementById('ytLinkSummary');
    if (sum) {
      sum.innerHTML =
        '<div style="font-weight:700;margin-bottom:4px">' + esc(sub.submitted_name || 'Anonymous') + '</div>' +
        (sub.submitted_email ? '<div style="font-size:13px;color:#555;margin-bottom:6px">' + esc(sub.submitted_email) + '</div>' : '') +
        (sub.short_message ? '<div style="font-size:13px;color:#444;margin-bottom:8px">"' + esc(sub.short_message) + '"</div>' : '') +
        '<div style="position:relative;padding-top:56.25%;border-radius:10px;overflow:hidden;background:#000;margin:6px 0">' +
          '<iframe src="' + esc(sub.youtube_embed_url || ('https://www.youtube.com/embed/' + (sub.youtube_video_id || ''))) +
          '" style="position:absolute;inset:0;width:100%;height:100%;border:0" allowfullscreen></iframe>' +
        '</div>';
    }

    var reuseSel = document.getElementById('ytLinkReuseSelect');
    var reuseChk = document.getElementById('ytLinkUseReuse');
    if (reuseSel) {
      reuseSel.innerHTML = '';
      (data.existing_owner_videos || []).forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.owner_id;
        opt.textContent = o.display_name + ' (existing video)';
        reuseSel.appendChild(opt);
      });
      var has = (data.existing_owner_videos || []).length > 0;
      reuseSel.disabled = !has;
      if (reuseChk) reuseChk.disabled = !has;
      var hint = document.getElementById('ytLinkReuseHint');
      if (hint) hint.textContent = has
        ? 'This submitter already has approved video(s). You can reuse one instead of the new upload.'
        : 'No previously approved video found for this submitter.';
    }

    var list = document.getElementById('ytLinkCodeList');
    if (list) {
      var codes = data.available_item_codes || [];
      list.innerHTML = codes.map(function (c) {
        var owned = c.current_owner_id
          ? ' <span style="font-size:11px;background:#f3eaff;color:#5a2a82;padding:1px 6px;border-radius:6px">→ ' + esc(c.current_owner_name || ('owner ' + c.current_owner_id)) + '</span>'
          : ' <span style="font-size:11px;background:#eef7ee;color:#0a7d2c;padding:1px 6px;border-radius:6px">unassigned</span>';
        return '<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #eee;border-radius:8px;margin-bottom:4px;background:#fff" data-code="' + esc(c.item_code) + '">' +
                 '<input type="checkbox" class="yt-link-code" value="' + esc(c.item_code) + '" />' +
                 '<span style="font-family:monospace">' + esc(c.item_code) + '</span>' + owned +
               '</label>';
      }).join('');
    }
  }

  function filterCodes() {
    var q = (document.getElementById('ytLinkCodeFilter') || {}).value || '';
    q = q.toLowerCase();
    var labels = document.querySelectorAll('#ytLinkCodeList > label');
    labels.forEach(function (l) {
      var code = (l.getAttribute('data-code') || '').toLowerCase();
      l.style.display = !q || code.indexOf(q) !== -1 ? '' : 'none';
    });
  }

  function confirmLink() {
    var subId = (document.getElementById('ytLinkSubId') || {}).value;
    if (!subId) return;

    var codes = Array.prototype.slice.call(document.querySelectorAll('.yt-link-code:checked')).map(function (c) { return c.value; });
    if (!codes.length) { setStatus('Select at least one item code.', 'err'); return; }

    var useReuse = (document.getElementById('ytLinkUseReuse') || {}).checked;
    var existingOwnerId = useReuse ? Number((document.getElementById('ytLinkReuseSelect') || {}).value || 0) : null;
    var makePublic = (document.getElementById('ytLinkMakePublic') || {}).checked;
    var notes = (document.getElementById('ytLinkNotes') || {}).value || '';

    setStatus('Linking...', '');
    api('POST', '/api/admin/youtube/testimonies/' + encodeURIComponent(subId) + '/approve-link', {
      item_codes: codes,
      use_existing_owner_video: useReuse,
      existing_owner_id: existingOwnerId,
      make_public: makePublic,
      admin_notes: notes
    }).then(function (r) {
      setStatus('Linked ' + (r.attached_codes ? r.attached_codes.length : 0) + ' code(s) to ' +
        (r.owner && r.owner.display_name) + '. Privacy: ' + r.privacy_status + '.', 'ok');
      // Refresh testimony list (if main admin-youtube.js is loaded)
      var reload = document.getElementById('ytReloadBtn');
      if (reload) reload.click();
    }).catch(function (e) { setStatus(e.message, 'err'); });
  }

  function close() {
    var panel = document.getElementById('ytLinkPanel');
    if (panel) show(panel, false);
  }

  // Expose openLinkPanel so other admin scripts can call it
  window.JIMKYouTubeLink = { open: openLinkPanel };

  document.addEventListener('DOMContentLoaded', function () {
    var b;
    if ((b = document.getElementById('ytLinkConfirmBtn'))) b.addEventListener('click', confirmLink);
    if ((b = document.getElementById('ytLinkCloseBtn')))   b.addEventListener('click', close);
    if ((b = document.getElementById('ytLinkCodeFilter'))) b.addEventListener('input', filterCodes);

    // Hook into existing testimony list: turn any [data-act="approve-link"] buttons live
    document.body.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || t.getAttribute('data-act') !== 'approve-link') return;
      var id = t.getAttribute('data-id');
      if (id) openLinkPanel(id);
    });
  });
})();
