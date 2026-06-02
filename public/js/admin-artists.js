(() => {
  const state = {
    list: [],
    selected: null,
    filters: { query: '', status: 'active' },
    settings: null
  };

  const el = {
    pill: document.getElementById('artistPill'),
    list: document.getElementById('artistList'),
    query: document.getElementById('artistQuery'),
    statusFilter: document.getElementById('artistStatusFilter'),
    newBtn: document.getElementById('newArtistBtn'),
    reloadBtn: document.getElementById('reloadArtistsBtn'),
    editorPill: document.getElementById('artistEditorPill'),
    qrHint: document.getElementById('artistQrHint'),
    id: document.getElementById('artistId'),
    slug: document.getElementById('artistSlug'),
    name: document.getElementById('artistDisplayName'),
    location: document.getElementById('artistLocation'),
    medium: document.getElementById('artistMedium'),
    joined: document.getElementById('artistJoined'),
    status: document.getElementById('artistStatus'),
    publicVideo: document.getElementById('artistPublicVideoUrl'),
    embedVideo: document.getElementById('artistEmbedVideoUrl'),
    shortQuote: document.getElementById('artistShortQuote'),
    bio: document.getElementById('artistBio'),
    testimony: document.getElementById('artistTestimony'),
    saveBtn: document.getElementById('saveArtistBtn'),
    clearBtn: document.getElementById('clearArtistBtn'),
    artworkFiles: document.getElementById('artistArtworkFiles'),
    artworkSetHero: document.getElementById('artistArtworkSetHero'),
    uploadBtn: document.getElementById('uploadArtworkBtn'),
    gallery: document.getElementById('artistArtworkGallery'),
    qrUrl: document.getElementById('artistQrUrl')
  };

  if (!el.list) return;

  const esc = (value = '') => String(value).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const slugify = (value) => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

  function adminKey() {
    return localStorage.getItem('jimk_admin_key') || '';
  }

  function setHint(message, ok = true) {
    el.qrHint.textContent = message;
    el.qrHint.className = ok ? 'note ok-text' : 'note danger-text';
  }

  async function api(path, options = {}) {
    const key = adminKey();
    if (!key) throw new Error('Save your admin key at the top first');
    const headers = { 'x-admin-key': key, ...(options.headers || {}) };
    const isJson = options.body && !(options.body instanceof FormData);
    if (isJson) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function absoluteAsset(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `${window.location.origin}${value.startsWith('/') ? '' : '/'}${value}`;
  }

  function renderList() {
    el.pill.textContent = `${state.list.length} artist${state.list.length === 1 ? '' : 's'}`;
    if (!state.list.length) {
      el.list.innerHTML = '<div class="empty">No artists found. Click "+ New artist" to add one.</div>';
      return;
    }
    el.list.innerHTML = state.list.map(artist => {
      const selected = state.selected && state.selected.id === artist.id ? 'selected' : '';
      const thumb = artist.hero_image_url
        ? `<div style="width:42px;height:42px;border-radius:8px;background-image:url('${esc(absoluteAsset(artist.hero_image_url))}');background-size:cover;background-position:center"></div>`
        : `<div style="width:42px;height:42px;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#f2c14e);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700">${esc((artist.display_name || 'A').charAt(0))}</div>`;
      return `
        <div class="card owner-card ${selected}">
          <button type="button" data-artist-open="${artist.id}">
            <div class="row" style="gap:12px;align-items:center">
              ${thumb}
              <div>
                <h4>${esc(artist.display_name)}</h4>
                <div class="owner-meta">${esc(artist.location || 'No location')} · ${artist.artwork_count} artwork</div>
                <div class="owner-meta">/${esc(artist.slug)}</div>
              </div>
            </div>
          </button>
        </div>
      `;
    }).join('');
    el.list.querySelectorAll('[data-artist-open]').forEach(btn => {
      btn.addEventListener('click', () => loadArtist(btn.dataset.artistOpen));
    });
  }

  function renderGallery() {
    if (!state.selected || !state.selected.artwork_urls.length) {
      el.gallery.innerHTML = '<div class="empty" style="grid-column:1/-1">No artwork uploaded yet.</div>';
      return;
    }
    const heroUrl = state.selected.hero_image_url;
    el.gallery.innerHTML = state.selected.artwork_urls.map(url => `
      <div class="card" style="padding:8px">
        <div style="position:relative;aspect-ratio:1/1;background-image:url('${esc(absoluteAsset(url))}');background-size:cover;background-position:center;border-radius:8px;border:${url === heroUrl ? '3px solid #f0c35b' : '1px solid rgba(255,255,255,.1)'}"></div>
        <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
          ${url === heroUrl ? '<span class="pill" style="background:rgba(240,195,91,.18);color:#ffd48d">Hero</span>' : `<button class="btn sm ghost" data-hero="${esc(url)}">Make hero</button>`}
          <button class="btn sm bad" data-remove="${esc(url)}">Remove</button>
        </div>
      </div>
    `).join('');

    el.gallery.querySelectorAll('[data-hero]').forEach(btn => {
      btn.addEventListener('click', () => setAsHero(btn.dataset.hero));
    });
    el.gallery.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => removeArtwork(btn.dataset.remove));
    });
  }

  function fillForm(artist) {
    el.id.value = artist?.id || '';
    el.slug.value = artist?.slug || '';
    el.name.value = artist?.display_name || '';
    el.location.value = artist?.location || '';
    el.medium.value = artist?.medium || '';
    el.joined.value = artist?.joined_label || '';
    el.status.value = artist?.status || 'active';
    el.publicVideo.value = artist?.public_video_url || '';
    el.embedVideo.value = artist?.embed_video_url || '';
    el.shortQuote.value = artist?.short_quote || '';
    el.bio.value = artist?.bio || '';
    el.testimony.value = artist?.testimony_summary || '';
    el.qrUrl.value = artist?.qr_url || '';
    el.editorPill.textContent = artist ? `Editing #${artist.id}` : 'No artist selected';
    if (artist && artist.qr_url) {
      setHint(`QR URL for this artist: ${artist.qr_url}`);
    } else {
      setHint('Save the artist to generate their QR URL.');
    }
    renderGallery();
  }

  function clearForm() {
    state.selected = null;
    fillForm(null);
    el.gallery.innerHTML = '<div class="empty" style="grid-column:1/-1">Save a new artist first, then upload artwork.</div>';
    renderList();
  }

  function collectPayload() {
    return {
      slug: slugify(el.slug.value || el.name.value),
      display_name: el.name.value.trim(),
      location: el.location.value.trim(),
      medium: el.medium.value.trim(),
      joined_label: el.joined.value.trim(),
      status: el.status.value,
      public_video_url: el.publicVideo.value.trim(),
      embed_video_url: el.embedVideo.value.trim(),
      short_quote: el.shortQuote.value.trim(),
      bio: el.bio.value.trim(),
      testimony_summary: el.testimony.value.trim()
    };
  }

  async function reloadArtists() {
    try {
      const data = await api(`/api/admin/artists?query=${encodeURIComponent(state.filters.query)}&status=${encodeURIComponent(state.filters.status)}&page_size=100`);
      state.list = data.items || [];
      renderList();
      if (state.selected) {
        const refreshed = state.list.find(a => a.id === state.selected.id);
        if (refreshed) {
          state.selected = refreshed;
          fillForm(refreshed);
        }
      }
    } catch (error) {
      setHint(error.message, false);
    }
  }

  async function loadArtist(id) {
    try {
      const data = await api(`/api/admin/artists/${id}`);
      state.selected = data.artist;
      fillForm(data.artist);
      renderList();
    } catch (error) {
      setHint(error.message, false);
    }
  }

  async function saveArtist() {
    try {
      const payload = collectPayload();
      if (!payload.display_name) throw new Error('Display name is required');
      const id = el.id.value.trim();
      const data = id
        ? await api(`/api/admin/artists/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await api('/api/admin/artists', { method: 'POST', body: JSON.stringify(payload) });
      state.selected = data.artist;
      await reloadArtists();
      fillForm(data.artist);
      setHint('Artist saved.');
    } catch (error) {
      setHint(error.message, false);
    }
  }

  async function uploadArtwork() {
    try {
      if (!state.selected) throw new Error('Save the artist first, then upload artwork');
      const files = Array.from(el.artworkFiles.files || []);
      if (!files.length) throw new Error('Select one or more image files');
      const form = new FormData();
      files.forEach(file => form.append('images', file));
      if (el.artworkSetHero.checked) form.append('set_as_hero', 'true');
      const data = await api(`/api/admin/artists/${state.selected.id}/artwork`, { method: 'POST', body: form });
      state.selected = data.artist;
      el.artworkFiles.value = '';
      el.artworkSetHero.checked = false;
      fillForm(data.artist);
      await reloadArtists();
      setHint(`Uploaded ${data.uploaded_urls.length} image(s).`);
    } catch (error) {
      setHint(error.message, false);
    }
  }

  async function setAsHero(url) {
    try {
      if (!state.selected) return;
      const data = await api(`/api/admin/artists/${state.selected.id}/hero`, { method: 'POST', body: JSON.stringify({ hero_image_url: url }) });
      state.selected = data.artist;
      fillForm(data.artist);
      await reloadArtists();
      setHint('Hero image updated.');
    } catch (error) {
      setHint(error.message, false);
    }
  }

  async function removeArtwork(url) {
    try {
      if (!state.selected) return;
      if (!window.confirm('Remove this artwork?')) return;
      const data = await api(`/api/admin/artists/${state.selected.id}/artwork`, {
        method: 'DELETE',
        body: JSON.stringify({ artwork_url: url })
      });
      state.selected = data.artist;
      fillForm(data.artist);
      await reloadArtists();
      setHint('Artwork removed.');
    } catch (error) {
      setHint(error.message, false);
    }
  }

  el.newBtn.addEventListener('click', clearForm);
  el.reloadBtn.addEventListener('click', reloadArtists);
  el.saveBtn.addEventListener('click', saveArtist);
  el.clearBtn.addEventListener('click', clearForm);
  el.uploadBtn.addEventListener('click', uploadArtwork);
  el.statusFilter.addEventListener('change', () => {
    state.filters.status = el.statusFilter.value;
    reloadArtists();
  });
  el.query.addEventListener('input', () => {
    state.filters.query = el.query.value.trim();
    reloadArtists();
  });
  el.name.addEventListener('input', () => {
    if (!el.id.value) el.slug.value = slugify(el.name.value);
  });

  setTimeout(() => {
    if (adminKey()) reloadArtists();
  }, 400);
})();
