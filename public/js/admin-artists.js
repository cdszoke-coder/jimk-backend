'use strict';

/**
 * Artists admin panel — drop-in version.
 *
 * Upload field-name resilience:
 *   - Portrait: tries 'portrait' -> 'file' -> 'image'
 *   - Artwork:  tries 'images'  -> 'files' -> 'artwork'
 *   Uses the first name that doesn't return "Unexpected field".
 *
 * Matches artist_profiles schema:
 *   id, slug, display_name, location, medium, joined_label,
 *   short_quote, bio, testimony_summary,
 *   public_video_url, embed_video_url,
 *   hero_image_url, portrait_image_url,
 *   hero_source ('artwork'|'portrait'),
 *   artwork_json (JSON string),
 *   status ('active'|'hidden'|'archived'),
 *   created_at, updated_at
 */

(function () {
  var BACKEND = ''; // same-origin

  function key() { return localStorage.getItem('jimk_admin_key') || ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function getVal(id) { var el = $(id); return el ? el.value : ''; }
  function setVal(id, v) { var el = $(id); if (el) el.value = (v == null ? '' : v); }

  function api(method, url, body, isForm) {
    var headers = { 'x-admin-key': key() };
    var opts = { method: method, headers: headers };
    if (body && isForm) {
      opts.body = body;
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(BACKEND + url, opts).then(function (r) {
      return r.text().then(function (t) {
        var j;
        try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: 'Non-JSON response: ' + t.slice(0, 200) }; }
        if (!r.ok) {
          var err = new Error(j.error || ('HTTP ' + r.status));
          err.status = r.status;
          err.body = j;
          throw err;
        }
        return j;
      });
    });
  }

  /**
   * Tries each candidate field name in order until one succeeds, OR
   * until we run out of candidates. Detects "Unexpected field" errors
   * (multer rejects the part), or 500/400 errors whose message contains
   * "unexpected field", and retries with the next candidate.
   */
  function tryFieldNames(url, files, fieldCandidates, extraFormPairs) {
    var attempt = 0;
    function next() {
      if (attempt >= fieldCandidates.length) {
        return Promise.reject(new Error('No accepted upload field name. Try renaming the field in the front-end or the backend.'));
      }
      var name = fieldCandidates[attempt++];
      var fd = new FormData();
      if (files && files.length === 1 && !files._multi) {
        fd.append(name, files[0]);
      } else if (files && files.length) {
        for (var i = 0; i < files.length; i++) fd.append(name, files[i]);
      }
      if (extraFormPairs) {
        Object.keys(extraFormPairs).forEach(function (k) { fd.append(k, extraFormPairs[k]); });
      }
      return api('POST', url, fd, true).catch(function (e) {
        var msg = String(e.message || '').toLowerCase();
        var isFieldError = msg.indexOf('unexpected field') !== -1 || msg.indexOf('multipart') !== -1;
        if (isFieldError) return next();
        throw e;
      });
    }
    return next();
  }

  /* --------------- artist list --------------- */
  function loadList() {
    if (!key()) return;
    var q = encodeURIComponent(getVal('artistSearch'));
    var s = encodeURIComponent(getVal('artistStatusFilter') || 'all');
    api('GET', '/api/admin/artists?q=' + q + '&status=' + s + '&page=1&page_size=100')
      .then(function (r) { renderList((r && r.items) || []); })
      .catch(function (e) {
        var el = $('artistList'); if (el) el.innerHTML = '<div style="color:#b00020">Error: ' + esc(e.message) + '</div>';
      });
  }

  function renderList(items) {
    var el = $('artistList');
    if (!el) return;
    if (!items.length) {
      el.innerHTML = '<div style="color:#666;padding:8px">No artists yet. Click "+ New artist" to add one.</div>';
      return;
    }
    el.innerHTML = items.map(function (a) {
      var hero = a.hero_image_url || a.portrait_image_url || '';
      var thumb = hero
        ? '<img src="' + esc(hero) + '" style="width:42px;height:42px;border-radius:8px;object-fit:cover;background:#eee" />'
        : '<div style="width:42px;height:42px;border-radius:8px;background:linear-gradient(135deg,#5a2a82,#b8860b)"></div>';
      return '<button type="button" data-id="' + a.id + '" class="artist-pick" style="display:flex;gap:10px;align-items:center;width:100%;text-align:left;padding:10px;border:1px solid #eee;border-radius:10px;background:#fff;margin-bottom:8px;cursor:pointer">' +
        thumb +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;color:#1f1530;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(a.display_name || '(no name)') + '</div>' +
          '<div style="font-size:12px;color:#777">' + esc(a.location || '') + ' &middot; ' + esc(a.medium || '') + '</div>' +
          '<div style="margin-top:2px"><span style="font-size:11px;background:#eee;color:#333;padding:1px 8px;border-radius:8px">' + esc(a.status || 'active') + '</span></div>' +
        '</div>' +
      '</button>';
    }).join('');
    el.querySelectorAll('button.artist-pick').forEach(function (b) {
      b.addEventListener('click', function () { openArtist(b.getAttribute('data-id')); });
    });
  }

  /* --------------- editor --------------- */
  function openArtist(id) {
    if (!id) return openNewArtist();
    api('GET', '/api/admin/artists/' + encodeURIComponent(id))
      .then(function (r) {
        var a = (r && r.artist) || r;
        renderEditor(a);
      })
      .catch(function (e) {
        var el = $('artistEditorBody'); if (el) el.innerHTML = '<div style="color:#b00020">Error: ' + esc(e.message) + '</div>';
      });
  }

  function openNewArtist() {
    renderEditor({
      id: '', slug: '', display_name: '', location: '', medium: '', joined_label: '',
      short_quote: '', bio: '', testimony_summary: '',
      public_video_url: '', embed_video_url: '',
      hero_image_url: '', portrait_image_url: '',
      hero_source: 'artwork', artwork_json: '[]',
      status: 'active', _isNew: true
    });
  }

  function parseArtwork(a) {
    if (Array.isArray(a.artwork_urls)) return a.artwork_urls;
    try { return JSON.parse(a.artwork_json || '[]') || []; } catch (e) { return []; }
  }

  function field(label, control) {
    return '<label style="display:block"><span style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">' + esc(label) + '</span>' + control + '</label>';
  }

  function renderEditor(a) {
    setVal('artistId', a.id || '');
    var artworks = parseArtwork(a);
    var heroSource = a.hero_source || 'artwork';

    var html = '' +
      '<div style="display:grid;gap:14px">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
          '<div style="font-size:18px;font-weight:700">' + (a._isNew ? 'New artist' : esc(a.display_name || '(no name)')) + '</div>' +
          (a.id ? '<span style="font-size:12px;background:#eee;color:#333;padding:2px 8px;border-radius:8px">id ' + esc(a.id) + '</span>' : '') +
          '<div style="margin-left:auto;display:flex;gap:8px">' +
            '<button type="button" id="saveArtistBtn" class="primary">Save</button>' +
            (a.id ? '<button type="button" id="reloadArtistBtn">Reload</button>' : '') +
          '</div>' +
        '</div>' +

        '<div style="display:grid;gap:10px;grid-template-columns:1fr 1fr">' +
          field('Display name', '<input type="text" id="f_display_name" value="' + esc(a.display_name) + '" />') +
          field('Slug', '<input type="text" id="f_slug" placeholder="auto from name if blank" value="' + esc(a.slug) + '" />') +
          field('Location', '<input type="text" id="f_location" value="' + esc(a.location) + '" />') +
          field('Medium', '<input type="text" id="f_medium" value="' + esc(a.medium) + '" />') +
          field('Joined label', '<input type="text" id="f_joined_label" value="' + esc(a.joined_label) + '" />') +
          field('Status',
            '<select id="f_status">' +
              '<option value="active"'   + (a.status === 'active'   ? ' selected' : '') + '>Active</option>' +
              '<option value="hidden"'   + (a.status === 'hidden'   ? ' selected' : '') + '>Hidden</option>' +
              '<option value="archived"' + (a.status === 'archived' ? ' selected' : '') + '>Archived</option>' +
            '</select>'
          ) +
        '</div>' +

        field('Short quote', '<input type="text" id="f_short_quote" value="' + esc(a.short_quote) + '" style="width:100%" />') +
        field('Bio', '<textarea id="f_bio" rows="3">' + esc(a.bio) + '</textarea>') +
        field('Testimony summary', '<textarea id="f_testimony_summary" rows="3">' + esc(a.testimony_summary) + '</textarea>') +

        '<div id="artistYoutubeMount"></div>' +

        // Portrait
        '<div style="border:1px solid #eee;border-radius:12px;padding:14px;background:#fff">' +
          '<div style="font-weight:700;margin-bottom:6px">Artist portrait (face/photo)</div>' +
          '<div style="font-size:13px;color:#666;margin-bottom:10px">Used as the hero image when "Hero source: portrait" is selected. Never appears in the public art gallery.</div>' +
          (a.portrait_image_url
            ? '<img src="' + esc(a.portrait_image_url) + '" style="width:140px;height:140px;object-fit:cover;border-radius:12px;background:#eee" />' +
              '<div style="margin-top:8px"><button type="button" id="removePortraitBtn" class="danger">Remove portrait</button></div>'
            : '<div style="color:#888;font-size:13px">No portrait uploaded yet.</div>'
          ) +
          '<div style="margin-top:10px">' +
            '<input type="file" id="portraitFile" accept="image/*,.heic,.heif" />' +
            ' <button type="button" id="uploadPortraitBtn">Upload portrait</button>' +
            ' <label style="margin-left:8px;font-size:13px"><input type="checkbox" id="portraitMakeHero" /> set as hero</label>' +
          '</div>' +
          '<div id="portraitStatus" style="margin-top:6px;font-size:13px"></div>' +
        '</div>' +

        // Artwork gallery
        '<div style="border:1px solid #eee;border-radius:12px;padding:14px;background:#fff">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
            '<div style="font-weight:700">Artwork gallery</div>' +
            '<div style="font-size:13px">Hero source: <strong>' + esc(heroSource) + '</strong></div>' +
          '</div>' +
          '<div id="artworkGrid" style="display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">' +
            (artworks.length
              ? artworks.map(function (url, idx) {
                  var isHero = (heroSource === 'artwork' && a.hero_image_url === url);
                  return '<div style="position:relative;border:2px solid ' + (isHero ? '#b8860b' : '#eee') + ';border-radius:10px;overflow:hidden;background:#fff">' +
                    '<img src="' + esc(url) + '" style="width:100%;height:120px;object-fit:cover;display:block" />' +
                    '<div style="display:flex;gap:4px;padding:6px;font-size:12px">' +
                      '<button type="button" class="set-hero" data-url="' + esc(url) + '" data-idx="' + idx + '">Set hero</button>' +
                      '<button type="button" class="del-art danger" data-url="' + esc(url) + '">Remove</button>' +
                    '</div>' +
                  '</div>';
                }).join('')
              : '<div style="color:#888;font-size:13px">No artwork uploaded yet.</div>'
            ) +
          '</div>' +
          '<div style="margin-top:12px">' +
            '<input type="file" id="artworkFiles" accept="image/*,.heic,.heif" multiple />' +
            ' <button type="button" id="uploadArtworkBtn">Upload artwork</button>' +
            ' <button type="button" id="useArtworkHeroBtn" style="margin-left:8px">Use artwork as hero source</button>' +
          '</div>' +
          '<div id="artworkStatus" style="margin-top:6px;font-size:13px"></div>' +
        '</div>' +
      '</div>';

    $('artistEditorBody').innerHTML = html;

    var b;
    if ((b = $('saveArtistBtn')))     b.addEventListener('click', saveArtist);
    if ((b = $('reloadArtistBtn')))   b.addEventListener('click', function () { openArtist(a.id); });
    if ((b = $('uploadPortraitBtn'))) b.addEventListener('click', uploadPortrait);
    if ((b = $('removePortraitBtn'))) b.addEventListener('click', removePortrait);
    if ((b = $('uploadArtworkBtn')))  b.addEventListener('click', uploadArtwork);
    if ((b = $('useArtworkHeroBtn'))) b.addEventListener('click', function () { setHeroSource('artwork'); });

    document.querySelectorAll('button.set-hero').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setHero(btn.getAttribute('data-url'), Number(btn.getAttribute('data-idx')));
      });
    });
    document.querySelectorAll('button.del-art').forEach(function (btn) {
      btn.addEventListener('click', function () { removeArtwork(btn.getAttribute('data-url')); });
    });

    mountArtistYoutubeSection(a);
  }

  function saveArtist() {
    var id = getVal('artistId');
    var payload = {
      display_name: getVal('f_display_name'),
      slug: getVal('f_slug') || undefined,
      location: getVal('f_location'),
      medium: getVal('f_medium'),
      joined_label: getVal('f_joined_label'),
      short_quote: getVal('f_short_quote'),
      bio: getVal('f_bio'),
      testimony_summary: getVal('f_testimony_summary'),
      status: getVal('f_status')
    };
    if (!payload.display_name) { alert('Display name is required.'); return; }

    var p = id
      ? api('PATCH', '/api/admin/artists/' + encodeURIComponent(id), payload)
      : api('POST',  '/api/admin/artists', payload);

    p.then(function (r) {
      var a = (r && r.artist) || r;
      loadList();
      openArtist(a.id || id);
    }).catch(function (e) { alert('Save failed: ' + e.message); });
  }

  /* --------------- portrait --------------- */
  function uploadPortrait() {
    var id = getVal('artistId');
    if (!id) { alert('Save the artist first.'); return; }
    var fileEl = $('portraitFile');
    var f = fileEl && fileEl.files && fileEl.files[0];
    if (!f) return;
    var makeHero = ($('portraitMakeHero') || {}).checked;

    setStatus('portraitStatus', 'Uploading (trying field names)...');
    var url = '/api/admin/artists/' + encodeURIComponent(id) + '/portrait';
    var extra = makeHero ? { make_hero: '1' } : null;
    var fileList = [f]; // single file

    tryFieldNames(url, fileList, ['portrait', 'file', 'image'], extra)
      .then(function () {
        setStatus('portraitStatus', 'Uploaded.', 'ok');
        openArtist(id);
      })
      .catch(function (e) {
        setStatus('portraitStatus', e.message, 'err');
      });
  }

  function removePortrait() {
    var id = getVal('artistId');
    if (!id) return;
    if (!confirm('Remove the portrait?')) return;
    api('DELETE', '/api/admin/artists/' + encodeURIComponent(id) + '/portrait')
      .then(function () { openArtist(id); })
      .catch(function (e) { alert(e.message); });
  }

  /* --------------- artwork --------------- */
  function uploadArtwork() {
    var id = getVal('artistId');
    if (!id) { alert('Save the artist first.'); return; }
    var fileEl = $('artworkFiles');
    var files = fileEl && fileEl.files;
    if (!files || !files.length) return;

    setStatus('artworkStatus', 'Uploading ' + files.length + ' file(s) (trying field names)...');
    var url = '/api/admin/artists/' + encodeURIComponent(id) + '/artwork';

    // Mark as multi-file so tryFieldNames appends each one
    var arr = Array.prototype.slice.call(files);
    arr._multi = true;

    tryFieldNames(url, arr, ['images', 'files', 'artwork'], null)
      .then(function () {
        setStatus('artworkStatus', 'Uploaded.', 'ok');
        openArtist(id);
      })
      .catch(function (e) {
        setStatus('artworkStatus', e.message, 'err');
      });
  }

  function removeArtwork(url) {
    var id = getVal('artistId');
    if (!id || !url) return;
    if (!confirm('Remove this artwork?')) return;
    api('DELETE', '/api/admin/artists/' + encodeURIComponent(id) + '/artwork', { url: url })
      .then(function () { openArtist(id); })
      .catch(function (e) { alert(e.message); });
  }

  function setHero(url, idx) {
    var id = getVal('artistId');
    if (!id) return;
    api('POST', '/api/admin/artists/' + encodeURIComponent(id) + '/hero', { source: 'artwork', url: url, index: idx })
      .then(function () { openArtist(id); })
      .catch(function (e) { alert(e.message); });
  }

  function setHeroSource(source) {
    var id = getVal('artistId');
    if (!id) return;
    api('POST', '/api/admin/artists/' + encodeURIComponent(id) + '/hero', { source: source })
      .then(function () { openArtist(id); })
      .catch(function (e) { alert(e.message); });
  }

  function setStatus(id, msg, kind) {
    var el = $(id); if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? '#b00020' : (kind === 'ok' ? '#0a7d2c' : '#333');
  }

  /* --------------- YouTube section mount --------------- */
  function mountArtistYoutubeSection(a) {
    var mount = $('artistYoutubeMount');
    if (!mount) return;
    mount.innerHTML =
      '<div style="border:1px solid #eee;border-radius:14px;padding:16px;background:#fff">' +
        '<h3 style="margin:0 0 6px">Artist testimony video</h3>' +
        '<p style="margin:0 0 12px;color:#555;font-size:13px">Uploading here sends the video to YouTube as Unlisted, adds it to the "Artists" playlist, and sets it as this artist\'s testimony video.</p>' +
        '<div id="artistYtCurrentWrap" style="margin-bottom:14px;display:none">' +
          '<div style="font-weight:600;font-size:13px;margin-bottom:6px">Current video on artist page</div>' +
          '<div style="position:relative;padding-top:56.25%;border-radius:10px;overflow:hidden;background:#000;max-width:520px">' +
            '<iframe id="artistYtCurrentFrame" src="" allowfullscreen style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>' +
          '</div>' +
          '<div style="margin-top:8px"><button type="button" id="artistYtRemoveBtn" class="danger">Remove video from artist page</button></div>' +
        '</div>' +
        '<input type="hidden" id="publicVideoUrl" />' +
        '<input type="hidden" id="embedVideoUrl" />' +
        '<div style="display:grid;gap:10px;grid-template-columns:1fr;max-width:520px">' +
          '<label style="font-weight:600;font-size:14px">Choose video file' +
            '<input type="file" id="artistYtFile" accept="video/*" style="display:block;margin-top:6px" /></label>' +
          '<label style="font-weight:600;font-size:14px">Title (optional)' +
            '<input type="text" id="artistYtTitle" placeholder="Optional video title" style="display:block;width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:10px;margin-top:6px" /></label>' +
          '<label style="display:flex;gap:8px;align-items:flex-start;font-size:14px">' +
            '<input type="checkbox" id="artistYtMakePublic" style="margin-top:4px" />' +
            '<span>Make this video public on the YouTube channel (only if the artist gave permission).</span>' +
          '</label>' +
          '<button id="artistYtUploadBtn" type="button" class="primary" style="padding:12px 18px;border:none;border-radius:12px;font-weight:700;cursor:pointer">Upload &amp; set as artist testimony video</button>' +
          '<div id="artistYtProgress" style="display:none;height:8px;background:#eee;border-radius:8px;overflow:hidden"><div style="height:100%;width:0;background:#5a2a82;transition:width .2s"></div></div>' +
          '<div id="artistYtStatus" style="font-weight:600;font-size:14px"></div>' +
        '</div>' +
      '</div>';

    if (window.JIMKArtistYouTubeUI && window.JIMKArtistYouTubeUI.showCurrentVideo) {
      window.JIMKArtistYouTubeUI.showCurrentVideo({
        public_video_url: a.public_video_url,
        embed_video_url: a.embed_video_url
      });
    } else {
      if (a.embed_video_url || a.public_video_url) {
        var f = $('artistYtCurrentFrame'); var w = $('artistYtCurrentWrap');
        if (f && w) { f.src = a.embed_video_url || ''; w.style.display = ''; }
      }
    }
  }

  /* --------------- wire top controls --------------- */
  function wire() {
    var b;
    if ((b = $('artistReloadBtn')))    b.addEventListener('click', loadList);
    if ((b = $('artistNewBtn')))       b.addEventListener('click', openNewArtist);
    if ((b = $('artistSearch')))       b.addEventListener('input', debounce(loadList, 250));
    if ((b = $('artistStatusFilter')) ) b.addEventListener('change', loadList);
  }
  function debounce(fn, ms) {
    var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  document.addEventListener('DOMContentLoaded', function () { wire(); loadList(); });
  document.addEventListener('jimk:key-changed', loadList);
  document.addEventListener('jimk:reload-all',  loadList);
})();
