'use strict';

/**
 * Admin: upload an artist video directly to YouTube (Artists playlist).
 * Expects the artist editor form to expose:
 *   - data attribute or hidden field with the current artist id, e.g. <input id="artistId" ...>
 * And the following elements added to the artist editor section:
 *   - artistYtFile        (input type=file)
 *   - artistYtTitle       (input type=text, optional)
 *   - artistYtMakePublic  (input type=checkbox)
 *   - artistYtUploadBtn   (button)
 *   - artistYtStatus      (div for status text)
 *   - artistYtProgress    (div progress bar wrapper with inner <div>)
 */

(function () {
  function key() { return localStorage.getItem('jimk_admin_key') || ''; }
  function getArtistId() {
    var el = document.getElementById('artistId');
    return el ? (el.value || el.getAttribute('data-id') || '') : '';
  }
  function setStatus(msg, kind) {
    var el = document.getElementById('artistYtStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? '#b00020' : (kind === 'ok' ? '#0a7d2c' : '#333');
  }
  function setProgress(pct) {
    var wrap = document.getElementById('artistYtProgress');
    if (!wrap) return;
    wrap.style.display = pct > 0 ? 'block' : 'none';
    var inner = wrap.querySelector('div');
    if (inner) inner.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  function upload() {
    var artistId = getArtistId();
    if (!artistId) { setStatus('Open an artist first.', 'err'); return; }
    var fileInput = document.getElementById('artistYtFile');
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) { setStatus('Choose a video file first.', 'err'); return; }
    if (file.size > 500 * 1024 * 1024) {
      setStatus('That video is too large (max 500 MB).', 'err');
      return;
    }

    var title = (document.getElementById('artistYtTitle') || {}).value || '';
    var makePublic = (document.getElementById('artistYtMakePublic') || {}).checked ? '1' : '0';

    var fd = new FormData();
    fd.append('video', file);
    if (title) fd.append('title', title);
    fd.append('make_public', makePublic);

    var btn = document.getElementById('artistYtUploadBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading...'; }
    setStatus('Uploading to YouTube...', '');
    setProgress(1);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/artists/' + encodeURIComponent(artistId) + '/youtube-video', true);
    xhr.setRequestHeader('x-admin-key', key());

    xhr.upload.onprogress = function (ev) {
      if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
    };

    xhr.onload = function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Upload to YouTube'; }
      setProgress(0);
      try {
        var data = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
          setStatus('Uploaded. Privacy: ' + data.privacy_status +
                    (data.added_to_artists_playlist ? ' — added to Artists playlist.' : ''), 'ok');
          // Reflect new video URL on existing form fields if present
          var pub = document.getElementById('publicVideoUrl');
          var emb = document.getElementById('embedVideoUrl');
          if (pub) pub.value = data.public_video_url || '';
          if (emb) emb.value = data.embed_video_url || '';
        } else {
          setStatus(data.error || 'Upload failed.', 'err');
        }
      } catch (e) {
        setStatus('Upload failed.', 'err');
      }
    };
    xhr.onerror = function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Upload to YouTube'; }
      setProgress(0);
      setStatus('Network error.', 'err');
    };

    xhr.send(fd);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('artistYtUploadBtn');
    if (btn) btn.addEventListener('click', upload);
  });
})();
