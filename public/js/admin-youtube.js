'use strict';

/**
 * Admin dashboard panel: YouTube connection + testimony video moderation.
 * Expects elements (added to admin.html) with these IDs:
 *  - ytStatus, ytConnectBtn, ytDisconnectBtn, ytEnsurePlaylistBtn
 *  - ytTestList, ytFilter, ytReloadBtn
 */

(function () {
  var adminKey = '';
  function key() {
    if (!adminKey) adminKey = localStorage.getItem('jimk_admin_key') || '';
    return adminKey;
  }
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
      }).catch(function (e) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        throw e;
      });
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }

  function renderStatus(info) {
    var el = document.getElementById('ytStatus');
    if (!el) return;
    if (info && info.connected) {
      el.innerHTML =
        '<div style="color:#0a7d2c;font-weight:600">Connected: ' + esc(info.channel_title || '(channel)') + '</div>' +
        '<div style="font-size:12px;color:#555">Default visibility: ' + esc(info.default_visibility) +
        ' &middot; Testimonials playlist: ' + (info.testimonials_playlist_id ? 'ready' : 'not yet created') + '</div>';
    } else {
      el.innerHTML = '<div style="color:#b00020;font-weight:600">Not connected to YouTube yet.</div>';
    }
  }

  function loadStatus() {
    return api('GET', '/api/admin/youtube/status').then(renderStatus)
      .catch(function (e) {
        var el = document.getElementById('ytStatus');
        if (el) el.textContent = 'Error: ' + e.message;
      });
  }

  function connect() {
    api('GET', '/api/admin/youtube/auth-url').then(function (r) {
      if (r && r.url) window.location.href = r.url;
    }).catch(function (e) { alert(e.message); });
  }

  function disconnect() {
    if (!confirm('Disconnect YouTube? You will need to reconnect to upload new testimony videos.')) return;
    api('POST', '/api/admin/youtube/disconnect').then(loadStatus);
  }

  function ensurePlaylist() {
    api('POST', '/api/admin/youtube/playlist/ensure').then(function () {
      loadStatus();
    }).catch(function (e) { alert(e.message); });
  }

  function loadList() {
    var status = (document.getElementById('ytFilter') || {}).value || 'pending';
    return api('GET', '/api/admin/youtube/testimonies?status=' + encodeURIComponent(status))
      .then(function (r) { renderList(r.items || []); })
      .catch(function (e) {
        var el = document.getElementById('ytTestList');
        if (el) el.textContent = 'Error: ' + e.message;
      });
  }

  function renderList(items) {
    var el = document.getElementById('ytTestList');
    if (!el) return;
    if (!items.length) { el.innerHTML = '<div style="color:#666">No testimonies in this view.</div>'; return; }
    el.innerHTML = items.map(function (it) {
      var embed = it.youtube_embed_url ? it.youtube_embed_url : ('https://www.youtube.com/embed/' + esc(it.youtube_video_id));
      var permTag = it.permission_public
        ? '<span style="background:#0a7d2c;color:#fff;padding:2px 8px;border-radius:8px;font-size:12px">Permission: public OK</span>'
        : '<span style="background:#777;color:#fff;padding:2px 8px;border-radius:8px;font-size:12px">Site only</span>';
      var statusTag = '<span style="background:#5a2a82;color:#fff;padding:2px 8px;border-radius:8px;font-size:12px">' + esc(it.review_status) + '</span>';
      var privTag = '<span style="background:#444;color:#fff;padding:2px 8px;border-radius:8px;font-size:12px">' + esc(it.privacy_status) + '</span>';
      return (
        '<div style="border:1px solid #eee;border-radius:14px;padding:14px;margin-bottom:14px;background:#fff">' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' + statusTag + ' ' + privTag + ' ' + permTag + '</div>' +
          '<div style="font-weight:700;margin-bottom:4px">' + esc(it.submitted_name) + '</div>' +
          (it.short_message ? '<div style="font-size:14px;color:#444;margin-bottom:8px">' + esc(it.short_message) + '</div>' : '') +
          '<div style="position:relative;padding-top:56.25%;border-radius:10px;overflow:hidden;background:#000;margin-bottom:10px">' +
            '<iframe src="' + esc(embed) + '" style="position:absolute;inset:0;width:100%;height:100%;border:0" allowfullscreen></iframe>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button data-act="approve" data-id="' + it.id + '" data-pub="0">Approve (keep unlisted)</button>' +
            (it.permission_public ? '<button data-act="approve" data-id="' + it.id + '" data-pub="1">Approve + make public</button>' : '') +
            '<button data-act="reject" data-id="' + it.id + '">Reject</button>' +
            '<button data-act="reject-delete" data-id="' + it.id + '">Reject + delete from YouTube</button>' +
            '<button data-act="public" data-id="' + it.id + '">Force public</button>' +
            '<button data-act="unlisted" data-id="' + it.id + '">Force unlisted</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    el.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        var act = b.getAttribute('data-act');
        var pub = b.getAttribute('data-pub') === '1';
        var note = '';
        if (act === 'approve') {
          api('POST', '/api/admin/youtube/testimonies/' + id + '/approve', { make_public: pub }).then(loadList);
        } else if (act === 'reject') {
          note = prompt('Optional reason for rejection:') || '';
          api('POST', '/api/admin/youtube/testimonies/' + id + '/reject', { admin_notes: note, delete_from_youtube: false }).then(loadList);
        } else if (act === 'reject-delete') {
          if (!confirm('Delete this video from YouTube? This cannot be undone.')) return;
          note = prompt('Optional reason for rejection:') || '';
          api('POST', '/api/admin/youtube/testimonies/' + id + '/reject', { admin_notes: note, delete_from_youtube: true }).then(loadList);
        } else if (act === 'public') {
          api('POST', '/api/admin/youtube/testimonies/' + id + '/make-public').then(loadList);
        } else if (act === 'unlisted') {
          api('POST', '/api/admin/youtube/testimonies/' + id + '/make-unlisted').then(loadList);
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn;
    if ((btn = document.getElementById('ytConnectBtn'))) btn.addEventListener('click', connect);
    if ((btn = document.getElementById('ytDisconnectBtn'))) btn.addEventListener('click', disconnect);
    if ((btn = document.getElementById('ytEnsurePlaylistBtn'))) btn.addEventListener('click', ensurePlaylist);
    if ((btn = document.getElementById('ytReloadBtn'))) btn.addEventListener('click', loadList);
    var f = document.getElementById('ytFilter');
    if (f) f.addEventListener('change', loadList);
    loadStatus();
    loadList();
  });
})();
