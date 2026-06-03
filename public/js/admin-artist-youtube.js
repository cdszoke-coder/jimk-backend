'use strict';

/**
 * Admin: upload an artist testimony video directly to YouTube.
 * The uploaded video becomes the artist's testimonial video on the artist page
 * (writes to public_video_url + embed_video_url and is added to the "Artists" playlist).
 *
 * Required DOM (provided by admin-artist-youtube-panel.html):
 *   #artistId                (input/value with the open artist's id)
 *   #artistYtFile            (file input)
 *   #artistYtTitle           (optional title)
 *   #artistYtMakePublic      (checkbox)
 *   #artistYtUploadBtn       (button)
 *   #artistYtStatus          (status text)
 *   #artistYtProgress > div  (progress bar)
 *   #artistYtCurrentWrap     (wrapper for current video preview)
 *   #artistYtCurrentFrame    (iframe for current video)
 *   #artistYtRemoveBtn       (button to clear video from artist)
 *   #publicVideoUrl          (hidden input, kept so existing admin code still reads it)
 *   #embedVideoUrl           (hidden input, kept so existing admin code still reads it)
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

  function toEmbedUrl(url) {
    if (!url) return '';
    // YouTube watch / youtu.be / shorts
    var m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (m) return 'https://www.youtube.com/embed/' + m[1];
    return url;
  }

  // Public API used by admin-artists.js when an artist is opened.
  // Pass the artist object (or any object with public_video_url / embed_video_url).
  window.JIMKArtistYouTubeUI = window.JIMKArtistYouTubeUI || {};
  window.JIMKArtistYouTubeUI.showCurrentVideo = function (artist) {
    var wrap = document.getElementById('artistYtCurrentWrap');
    var frame = document.getElementById('artistYtCurrentFrame');
    var pub = document.getElementById('publicVideoUrl');
    var emb = document.getElementById('embedVideoUrl');

    var publicUrl = (artist && (artist.public_video_url || artist.publicVideoUrl)) || '';
    var embedUrl  = (artist && (artist.embed_video_url  || artist.embedVideoUrl))  || toEmbedUrl(publicUrl);

    if (pub) pub.value = publicUrl;
    if (emb) emb.value = embedUrl;

    if (wrap && frame) {
      if (embedUrl) {
        frame.src = embedUrl;
        wrap.style.display = '';
      } else {
        frame.src = '';
        wrap.style.display = 'none';
      }
    }
  };

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
      if (btn) { btn.disabled = false; btn.textContent = 'Upload & set as artist testimony video'; }
      setProgress(0);
      try {
        var data = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
          setStatus('Done. Privacy: ' + data.privacy_status +
                    (data.added_to_artists_playlist ? ' — added to Artists playlist.' : ''), 'ok');
          window.JIMKArtistYouTubeUI.showCurrentVideo({
            public_video_url: data.public_video_url,
            embed_video_url: data.embed_video_url
          });
          if (fileInput) fileInput.value = '';
        } else {
          setStatus(data.error || 'Upload failed.', 'err');
        }
      } catch (e) {
        setStatus('Upload failed.', 'err');
      }
    };
    xhr.onerror = function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Upload & set as artist testimony video'; }
      setProgress(0);
      setStatus('Network error.', 'err');
    };

    xhr.send(fd);
  }

  function removeVideo() {
    var artistId = getArtistId();
    if (!artistId) { setStatus('Open an artist first.', 'err'); return; }
    if (!confirm('Remove the testimony video from this artist page? (The video stays on YouTube.)')) return;

    fetch('/api/admin/artists/' + encodeURIComponent(artistId) + '/youtube-video/clear', {
      method: 'POST',
      headers: { 'x-admin-key': key() }
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          setStatus('Removed from artist page.', 'ok');
          window.JIMKArtistYouTubeUI.showCurrentVideo({ public_video_url: '', embed_video_url: '' });
        } else {
          setStatus((data && data.error) || 'Failed to remove.', 'err');
        }
      })
      .catch(function () { setStatus('Network error.', 'err'); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var b1 = document.getElementById('artistYtUploadBtn');
    if (b1) b1.addEventListener('click', upload);
    var b2 = document.getElementById('artistYtRemoveBtn');
    if (b2) b2.addEventListener('click', removeVideo);
  });
})();
