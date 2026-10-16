'use strict';
/**
 * admin-art-pieces.js — Jesus Is My King admin
 * ---------------------------------------------------------------------------
 * Adds a "Details & QR codes" button under every artwork in the Artists
 * editor (admin-artists.js). The panel lets you:
 *   1. Describe the piece: title, description (with a "show on site" toggle,
 *      for artists who don't want theirs described), artist quote, medium,
 *      year, and an "original available" flag.
 *   2. Create a QR code for each item the art is printed on (T-shirt,
 *      sticker, makeup bag, hoodie, tote, mug... or any custom item).
 *      Each QR gets its own permanent code, e.g. JIMK-ART-0007, and leads to
 *      that exact artwork at the top of the artist's page.
 *   3. Download each QR as a print-ready PNG (2000px) or SVG, copy its link,
 *      and see how many times it has been scanned.
 *
 * Load it on admin.html AFTER admin-artists.js:
 *   <script src="js/admin-art-pieces.js"></script>
 * Needs the backend route src/routes/artworkPieces.js.
 */
(function () {
  var SITE = 'https://www.jesusismykingmovement.com';
  var QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  var ITEM_TYPES = [
    ['t-shirt', 'T-shirt'], ['hoodie', 'Hoodie'], ['crewneck', 'Crewneck'], ['hat', 'Hat'],
    ['sticker', 'Sticker'], ['makeup bag', 'Makeup bag'], ['tote bag', 'Tote bag'],
    ['mug', 'Mug'], ['phone case', 'Phone case'], ['poster', 'Poster / print'],
    ['canvas', 'Canvas'], ['__other', 'Other…']
  ];

  /* ------------------------------------------------------------ utilities */
  function key() { return localStorage.getItem('jimk_admin_key') || ''; }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function api(method, url, body) {
    var opts = { method: method, headers: { 'x-admin-key': key() } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var j; try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: 'Non-JSON response (is artworkPieces.js deployed?)' }; }
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function scanUrl(code) { return SITE + '/artist.html?art=' + encodeURIComponent(code); }
  function niceItem(t) {
    for (var i = 0; i < ITEM_TYPES.length; i++) if (ITEM_TYPES[i][0] === t) return ITEM_TYPES[i][1];
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Item';
  }

  var qrLoading = null;
  function loadQrLib() {
    if (window.qrcode) return Promise.resolve();
    if (qrLoading) return qrLoading;
    qrLoading = new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = QR_LIB; s.onload = ok; s.onerror = function () { fail(new Error('Could not load QR library')); };
      document.head.appendChild(s);
    });
    return qrLoading;
  }
  function makeQr(text) {
    var qr = window.qrcode(0, 'H');         // auto version, error-correction H (best for fabric)
    qr.addData(text); qr.make();
    return qr;
  }
  function qrPngDataUrl(text, px) {
    var qr = makeQr(text), n = qr.getModuleCount(), quiet = 4;
    var cell = Math.max(1, Math.floor(px / (n + quiet * 2)));
    var size = cell * (n + quiet * 2);
    var c = document.createElement('canvas'); c.width = c.height = size;
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var col = 0; col < n; col++)
      if (qr.isDark(r, col)) g.fillRect((col + quiet) * cell, (r + quiet) * cell, cell, cell);
    return c.toDataURL('image/png');
  }
  function qrSvg(text) {
    var qr = makeQr(text), n = qr.getModuleCount(), q = 4, s = n + q * 2, d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++)
      if (qr.isDark(r, c)) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s + ' ' + s + '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  function download(name, href) {
    var a = document.createElement('a'); a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------------------------------------------------------------- state */
  var state = { artistId: null, artistSlug: '', pieces: {} };   // pieces keyed by artwork_url

  function loadPieces(artistId) {
    return api('GET', '/api/admin/art-pieces?artist_id=' + encodeURIComponent(artistId)).then(function (r) {
      state.pieces = {};
      (r.pieces || []).forEach(function (p) { state.pieces[p.artwork_url] = p; });
    });
  }

  /* ---------------------------------------------------- styles (once) */
  function injectStyles() {
    if ($('jimkArtPieceStyles')) return;
    var st = document.createElement('style'); st.id = 'jimkArtPieceStyles';
    st.textContent =
      '.ap-btn{width:calc(100% - 12px);margin:0 6px 6px;font-size:12px;padding:6px 8px;border-radius:8px;border:1px solid #5a2a82;background:#faf6ff;color:#5a2a82;font-weight:700;cursor:pointer}' +
      '.ap-btn:hover{background:#5a2a82;color:#fff}' +
      '.ap-meta{font-size:11px;color:#666;padding:0 6px 6px;line-height:1.35}' +
      '.ap-meta b{color:#1f1530}' +
      '.ap-overlay{position:fixed;inset:0;background:rgba(20,10,30,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:30px 14px}' +
      '.ap-modal{background:#fff;border-radius:16px;max-width:980px;width:100%;box-shadow:0 30px 80px rgba(0,0,0,.35);font-family:Inter,system-ui,sans-serif}' +
      '.ap-head{display:flex;gap:14px;align-items:center;padding:16px 18px;border-bottom:1px solid #eee}' +
      '.ap-head img{width:56px;height:56px;object-fit:cover;border-radius:10px;background:#eee}' +
      '.ap-head h3{margin:0;font-size:18px}' +
      '.ap-head .x{margin-left:auto;font-size:22px;border:none;background:none;cursor:pointer;color:#555}' +
      '.ap-body{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:18px}' +
      '.ap-card{border:1px solid #eee;border-radius:12px;padding:14px;background:#fafafa}' +
      '.ap-card h4{margin:0 0 4px;font-size:15px}' +
      '.ap-card .hint{font-size:12px;color:#666;margin:0 0 12px}' +
      '.ap-f{display:block;margin-bottom:10px}' +
      '.ap-f span{display:block;font-size:12px;font-weight:700;color:#333;margin-bottom:4px}' +
      '.ap-f input[type=text],.ap-f textarea,.ap-f select{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ddd;border-radius:9px;font:inherit;font-size:14px;background:#fff}' +
      '.ap-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
      '.ap-check{display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-bottom:10px}' +
      '.ap-check input{margin-top:3px}' +
      '.ap-status{font-size:13px;font-weight:600;min-height:18px;margin-top:6px}' +
      '.ap-code{display:grid;grid-template-columns:112px 1fr;gap:12px;background:#fff;border:1px solid #eee;border-radius:12px;padding:10px;margin-top:10px}' +
      '.ap-code img{width:112px;height:112px;image-rendering:pixelated;border:1px solid #eee;border-radius:6px}' +
      '.ap-code .c{font-family:"Courier New",monospace;font-weight:700;color:#7d5f08}' +
      '.ap-code .it{display:inline-block;background:#efe3bf;color:#7d5f08;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;border-radius:999px;padding:2px 8px;margin-left:6px}' +
      '.ap-code .u{font-size:11px;color:#555;word-break:break-all;margin:4px 0}' +
      '.ap-code .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
      '.ap-code .acts button{font-size:12px;padding:5px 9px}' +
      '.ap-empty{font-size:13px;color:#888;margin-top:10px}' +
      '@media(max-width:820px){.ap-body{grid-template-columns:1fr}}';
    document.head.appendChild(st);
  }

  /* -------------------------------------------- decorate artwork tiles */
  function decorate() {
    var grid = $('artworkGrid'); if (!grid) return;
    var id = ($('artistId') || {}).value;
    if (!id) return;
    var tiles = grid.querySelectorAll('button.del-art');
    if (!tiles.length) return;

    var go = function () {
      tiles.forEach(function (delBtn) {
        var tile = delBtn.closest('div[style*="position:relative"]') || delBtn.parentNode.parentNode;
        if (!tile || tile.querySelector('.ap-btn')) return;
        var url = delBtn.getAttribute('data-url');
        var p = state.pieces[url];
        var meta = document.createElement('div'); meta.className = 'ap-meta';
        meta.innerHTML = p
          ? '<b>' + esc(p.title || 'Untitled') + '</b><br>' + (p.description ? (p.show_description ? 'Described' : 'Description hidden') : 'No description') +
            ' · ' + (p.codes ? p.codes.length : 0) + ' QR'
          : 'No details yet';
        var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ap-btn';
        btn.textContent = 'Details & QR codes';
        btn.addEventListener('click', function () { openPanel(url); });
        tile.appendChild(meta); tile.appendChild(btn);
      });
    };

    if (state.artistId !== id) {
      state.artistId = id; state.pieces = {}; state.loaded = false;
      loadPieces(id).catch(function (e) { console.warn('[art-pieces]', e.message); })
        .then(function () { if (state.artistId === id) { state.loaded = true; go(); } });
    } else if (state.loaded) go();
  }

  /* ------------------------------------------------------------- panel */
  function openPanel(url) {
    injectStyles();
    var p = state.pieces[url] || {};
    var ov = document.createElement('div'); ov.className = 'ap-overlay'; ov.id = 'apOverlay';
    ov.innerHTML =
      '<div class="ap-modal" role="dialog" aria-modal="true">' +
        '<div class="ap-head"><img src="' + esc(url) + '" alt="" />' +
          '<div><h3>Artwork details &amp; QR codes</h3><div style="font-size:12px;color:#777">' + esc(url.split('/').pop()) + '</div></div>' +
          '<button class="x" type="button" id="apClose" aria-label="Close">×</button></div>' +
        '<div class="ap-body">' +
          '<div class="ap-card">' +
            '<h4>1 · About this piece</h4>' +
            '<p class="hint">Everything is optional. Shown at the top of the artist page when someone scans this art.</p>' +
            '<label class="ap-f"><span>Title</span><input type="text" id="apTitle" maxlength="200" value="' + esc(p.title) + '" placeholder="e.g. The Hill" /></label>' +
            '<label class="ap-f"><span>Description</span><textarea id="apDesc" rows="5" maxlength="4000" placeholder="What the piece is, what inspired it, what it means to the artist...">' + esc(p.description) + '</textarea></label>' +
            '<label class="ap-check"><input type="checkbox" id="apShowDesc"' + (p.id && !p.show_description ? '' : ' checked') + ' /><span><b>Show the description on the website.</b> Untick it if the artist would rather not have this piece described. The text stays saved here.</span></label>' +
            '<label class="ap-f"><span>Artist quote (optional)</span><input type="text" id="apQuote" maxlength="600" value="' + esc(p.quote) + '" placeholder="A sentence in the artist’s own words" /></label>' +
            '<div class="ap-row">' +
              '<label class="ap-f"><span>Medium</span><input type="text" id="apMedium" maxlength="120" value="' + esc(p.medium) + '" placeholder="Graphite on paper" /></label>' +
              '<label class="ap-f"><span>Year</span><input type="text" id="apYear" maxlength="20" value="' + esc(p.year) + '" placeholder="2026" /></label>' +
            '</div>' +
            '<label class="ap-check"><input type="checkbox" id="apForSale"' + (p.original_for_sale ? ' checked' : '') + ' /><span>The <b>original</b> is available — show an “Inquire about the original” button.</span></label>' +
            '<label class="ap-f"><span>Inquiry link (optional)</span><input type="text" id="apInquiry" maxlength="500" value="' + esc(p.inquiry_url) + '" placeholder="contact.html?topic=original-art" /></label>' +
            '<button type="button" class="primary" id="apSave">Save details</button>' +
            '<div class="ap-status" id="apSaveStatus"></div>' +
          '</div>' +
          '<div class="ap-card">' +
            '<h4>2 · QR codes for printed items</h4>' +
            '<p class="hint">Make one QR for each product this art is printed on. Every code is permanent and leads to this exact piece at the top of the artist page. The page names the item (sticker, makeup bag...) so the person scanning knows what they’re looking at.</p>' +
            '<div class="ap-row">' +
              '<label class="ap-f"><span>Printed on</span><select id="apItemType">' +
                ITEM_TYPES.map(function (t) { return '<option value="' + esc(t[0]) + '">' + esc(t[1]) + '</option>'; }).join('') +
              '</select></label>' +
              '<label class="ap-f" id="apOtherWrap" style="display:none"><span>Item name</span><input type="text" id="apOther" maxlength="60" placeholder="e.g. water bottle" /></label>' +
            '</div>' +
            '<label class="ap-f"><span>Product / shop link (optional)</span><input type="text" id="apShop" maxlength="500" placeholder="shop.html or a product URL" /></label>' +
            '<button type="button" class="primary" id="apNewCode">+ Create QR code</button>' +
            '<div class="ap-status" id="apCodeStatus"></div>' +
            '<div id="apCodes"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    function close() { ov.remove(); document.removeEventListener('keydown', onKey); refreshTiles(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    $('apClose').addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });

    $('apItemType').addEventListener('change', function () {
      $('apOtherWrap').style.display = this.value === '__other' ? '' : 'none';
    });
    $('apSave').addEventListener('click', function () { saveDetails(url); });
    $('apNewCode').addEventListener('click', function () { createCode(url); });

    renderCodes(url);
  }

  function setStatus(id, msg, kind) {
    var el = $(id); if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'err' ? '#b00020' : (kind === 'ok' ? '#0a7d2c' : '#333');
  }

  function collectDetails(url) {
    return {
      artist_id: state.artistId,
      artwork_url: url,
      title: $('apTitle').value,
      description: $('apDesc').value,
      show_description: $('apShowDesc').checked,
      quote: $('apQuote').value,
      medium: $('apMedium').value,
      year: $('apYear').value,
      original_for_sale: $('apForSale').checked,
      inquiry_url: $('apInquiry').value
    };
  }

  function saveDetails(url) {
    setStatus('apSaveStatus', 'Saving...');
    return api('PUT', '/api/admin/art-pieces', collectDetails(url)).then(function (r) {
      var codes = (state.pieces[url] && state.pieces[url].codes) || [];
      state.pieces[url] = Object.assign(r.piece, { codes: codes });
      setStatus('apSaveStatus', 'Saved.', 'ok');
      return state.pieces[url];
    }).catch(function (e) { setStatus('apSaveStatus', 'Save failed: ' + e.message, 'err'); throw e; });
  }

  function createCode(url) {
    var type = $('apItemType').value;
    if (type === '__other') {
      type = ($('apOther').value || '').trim().toLowerCase();
      if (!type) { setStatus('apCodeStatus', 'Type the item name first.', 'err'); return; }
    }
    setStatus('apCodeStatus', 'Creating...');
    // Saving first guarantees the piece exists (and keeps any typed details).
    saveDetails(url).then(function (piece) {
      return api('POST', '/api/admin/art-pieces/' + piece.id + '/codes', {
        item_type: type, shop_url: $('apShop').value
      });
    }).then(function (r) {
      state.pieces[url].codes = (state.pieces[url].codes || []).concat([r.code]);
      setStatus('apCodeStatus', 'Created ' + r.code.code + ' for ' + niceItem(r.code.item_type) + '.', 'ok');
      renderCodes(url);
    }).catch(function (e) { setStatus('apCodeStatus', 'Could not create code: ' + e.message, 'err'); });
  }

  function renderCodes(url) {
    var box = $('apCodes'); if (!box) return;
    var codes = (state.pieces[url] && state.pieces[url].codes) || [];
    if (!codes.length) { box.innerHTML = '<div class="ap-empty">No QR codes yet for this artwork.</div>'; return; }
    box.innerHTML = '<div class="ap-empty">Loading QR previews...</div>';
    loadQrLib().then(function () {
      box.innerHTML = codes.slice().reverse().map(function (c) {
        var link = scanUrl(c.code);
        return '<div class="ap-code" data-code="' + esc(c.code) + '">' +
          '<img alt="QR ' + esc(c.code) + '" src="' + qrPngDataUrl(link, 336) + '" />' +
          '<div>' +
            '<div><span class="c">' + esc(c.code) + '</span><span class="it">' + esc(niceItem(c.item_type)) + '</span></div>' +
            '<div class="u">' + esc(link) + '</div>' +
            '<div style="font-size:11px;color:#777">Scanned ' + (c.scan_count || 0) + '×' + (c.last_scan_at ? ' · last ' + esc(c.last_scan_at) : '') + '</div>' +
            '<div class="acts">' +
              '<button type="button" data-act="png">PNG (print)</button>' +
              '<button type="button" data-act="svg">SVG</button>' +
              '<button type="button" data-act="copy">Copy link</button>' +
              '<button type="button" data-act="test">Test</button>' +
              '<button type="button" data-act="retire" class="danger">Retire</button>' +
            '</div>' +
          '</div></div>';
      }).join('');
      box.querySelectorAll('.ap-code button').forEach(function (b) {
        b.addEventListener('click', function () {
          var code = b.closest('.ap-code').getAttribute('data-code');
          var c = codes.filter(function (x) { return x.code === code; })[0];
          codeAction(url, c, b.getAttribute('data-act'), b);
        });
      });
    }).catch(function (e) { box.innerHTML = '<div class="ap-empty" style="color:#b00020">' + esc(e.message) + '</div>'; });
  }

  function codeAction(url, c, act, btn) {
    var link = scanUrl(c.code);
    var base = c.code + '_' + String(c.item_type).replace(/[^a-z0-9]+/gi, '-');
    if (act === 'png') download(base + '.png', qrPngDataUrl(link, 2000));
    else if (act === 'svg') download(base + '.svg', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qrSvg(link)));
    else if (act === 'test') window.open(link, '_blank', 'noopener');
    else if (act === 'copy') {
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () {
        btn.textContent = 'Copied!'; setTimeout(function () { btn.textContent = 'Copy link'; }, 1400);
      }).catch(function () { window.prompt('Copy this link:', link); });
    } else if (act === 'retire') {
      if (!confirm('Retire ' + c.code + '? Anyone who scans it will see the artist page without this piece spotlighted. The code number is never reused.')) return;
      api('DELETE', '/api/admin/art-codes/' + encodeURIComponent(c.code)).then(function () {
        state.pieces[url].codes = state.pieces[url].codes.filter(function (x) { return x.code !== c.code; });
        renderCodes(url);
      }).catch(function (e) { alert(e.message); });
    }
  }

  function refreshTiles() {
    var grid = $('artworkGrid'); if (!grid) return;
    grid.querySelectorAll('.ap-btn,.ap-meta').forEach(function (n) { n.remove(); });
    decorate();
  }

  /* ---------------------------------------------------------------- boot */
  function boot() {
    injectStyles();
    var host = $('artistEditorBody') || document.body;
    var t = null;
    new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(function () {
        var id = ($('artistId') || {}).value;
        if (id && id !== state.artistId) { state.artistId = null; }
        decorate();
      }, 60);
    }).observe(host, { childList: true, subtree: true });
    decorate();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
