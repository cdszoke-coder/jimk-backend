(() => {
  const state = {
    adminKey: localStorage.getItem('jimk_admin_key') || '',
    summary: null,
    queue: null,
    owners: null,
    selectedSubmission: null,
    selectedOwner: null,
    selectedSubmissionIds: new Set(),
    submissionFilters: { query: '', status: 'pending', page: 1, pageSize: 20 },
    ownerFilters: { query: '', status: 'all', page: 1, pageSize: 10 },
    auditLogs: []
  };

  const el = {
    adminKey: document.getElementById('adminKey'),
    saveKeyBtn: document.getElementById('saveKeyBtn'),
    reloadAllBtn: document.getElementById('reloadAllBtn'),
    reloadAuditBtn: document.getElementById('reloadAuditBtn'),
    statusNote: document.getElementById('statusNote'),
    statPending: document.getElementById('statPending'),
    statApprovedNew: document.getElementById('statApprovedNew'),
    statMerged: document.getElementById('statMerged'),
    statRejected: document.getElementById('statRejected'),
    statOwners: document.getElementById('statOwners'),
    statClaimed: document.getElementById('statClaimed'),
    statDefaultCodes: document.getElementById('statDefaultCodes'),
    queuePill: document.getElementById('queuePill'),
    submissionQuery: document.getElementById('submissionQuery'),
    submissionStatus: document.getElementById('submissionStatus'),
    submissionPageSize: document.getElementById('submissionPageSize'),
    applySubmissionFiltersBtn: document.getElementById('applySubmissionFiltersBtn'),
    selectAllVisibleBtn: document.getElementById('selectAllVisibleBtn'),
    bulkRejectBtn: document.getElementById('bulkRejectBtn'),
    selectedCountLabel: document.getElementById('selectedCountLabel'),
    submissionRangeLabel: document.getElementById('submissionRangeLabel'),
    submissionList: document.getElementById('submissionList'),
    submissionPrevBtn: document.getElementById('submissionPrevBtn'),
    submissionNextBtn: document.getElementById('submissionNextBtn'),
    submissionPageLabel: document.getElementById('submissionPageLabel'),
    reviewStatusPill: document.getElementById('reviewStatusPill'),
    submissionReview: document.getElementById('submissionReview'),
    ownerPill: document.getElementById('ownerPill'),
    ownerQuery: document.getElementById('ownerQuery'),
    ownerStatusFilter: document.getElementById('ownerStatusFilter'),
    ownerPageSize: document.getElementById('ownerPageSize'),
    ownerList: document.getElementById('ownerList'),
    ownerPrevBtn: document.getElementById('ownerPrevBtn'),
    ownerNextBtn: document.getElementById('ownerNextBtn'),
    ownerPageLabel: document.getElementById('ownerPageLabel'),
    ownerId: document.getElementById('ownerId'),
    ownerSlug: document.getElementById('ownerSlug'),
    ownerDisplayName: document.getElementById('ownerDisplayName'),
    ownerEmail: document.getElementById('ownerEmail'),
    ownerLocation: document.getElementById('ownerLocation'),
    ownerStatus: document.getElementById('ownerStatus'),
    ownerItemCodes: document.getElementById('ownerItemCodes'),
    ownerPublicVideoUrl: document.getElementById('ownerPublicVideoUrl'),
    ownerEmbedVideoUrl: document.getElementById('ownerEmbedVideoUrl'),
    ownerShortQuote: document.getElementById('ownerShortQuote'),
    ownerSummary: document.getElementById('ownerSummary'),
    replaceOwnerVideoToggle: document.getElementById('replaceOwnerVideoToggle'),
    saveOwnerBtn: document.getElementById('saveOwnerBtn'),
    approveNewOwnerBtn: document.getElementById('approveNewOwnerBtn'),
    mergeIntoOwnerBtn: document.getElementById('mergeIntoOwnerBtn'),
    clearOwnerDraftBtn: document.getElementById('clearOwnerDraftBtn'),
    ownerHint: document.getElementById('ownerHint'),
    founderName: document.getElementById('founderName'),
    founderPublicVideoUrl: document.getElementById('founderPublicVideoUrl'),
    founderEmbedVideoUrl: document.getElementById('founderEmbedVideoUrl'),
    founderShortQuote: document.getElementById('founderShortQuote'),
    founderSummary: document.getElementById('founderSummary'),
    siteBaseUrl: document.getElementById('siteBaseUrl'),
    saveFounderBtn: document.getElementById('saveFounderBtn'),
    bulkItemCodes: document.getElementById('bulkItemCodes'),
    importItemCodesBtn: document.getElementById('importItemCodesBtn'),
    auditList: document.getElementById('auditList')
  };

  const esc = (value = '') => String(value).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const parseCodes = (value) => [...new Set(String(value || '').split(/[\n,]+/).map(x => x.trim().toUpperCase()).filter(Boolean))];
  const slugify = (value) => String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const debounce = (fn, wait = 300) => {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  };

  function setStatus(message, ok = true) {
    el.statusNote.textContent = message;
    el.statusNote.className = ok ? 'note ok-text' : 'note danger-text';
  }

  function authHeaders() {
    return { 'Content-Type': 'application/json', 'x-admin-key': state.adminKey };
  }

  async function api(path, options = {}) {
    if (!state.adminKey) throw new Error('Admin API key required');
    const res = await fetch(path, {
      ...options,
      headers: { ...(options.headers || {}), ...authHeaders() }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function setButtonLoading(button, loading, loadingText) {
    if (!button) return;
    if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
    button.disabled = loading;
    button.textContent = loading ? loadingText : button.dataset.defaultText;
  }

  function collectOwnerPayload() {
    return {
      slug: slugify(el.ownerSlug.value || el.ownerDisplayName.value),
      display_name: el.ownerDisplayName.value.trim(),
      email: el.ownerEmail.value.trim(),
      location: el.ownerLocation.value.trim(),
      status: el.ownerStatus.value,
      item_codes: parseCodes(el.ownerItemCodes.value),
      public_video_url: el.ownerPublicVideoUrl.value.trim(),
      embed_video_url: el.ownerEmbedVideoUrl.value.trim(),
      short_quote: el.ownerShortQuote.value.trim(),
      testimony_summary: el.ownerSummary.value.trim()
    };
  }

  function fillFounder(founder) {
    el.founderName.value = founder?.display_name || '';
    el.founderPublicVideoUrl.value = founder?.public_video_url || '';
    el.founderEmbedVideoUrl.value = founder?.embed_video_url || '';
    el.founderShortQuote.value = founder?.short_quote || '';
    el.founderSummary.value = founder?.testimony_summary || '';
    el.siteBaseUrl.value = founder?.site_base_url || '';
  }

  function fillOwnerDraft(record, source = 'submission') {
    if (!record) return;
    el.ownerId.value = source === 'owner' ? record.id : '';
    el.ownerSlug.value = record.slug || slugify(record.display_name || record.submitted_name || '');
    el.ownerDisplayName.value = record.display_name || record.submitted_name || '';
    el.ownerEmail.value = record.email || record.submitted_email || '';
    el.ownerLocation.value = record.location || '';
    el.ownerStatus.value = record.status || 'active';
    el.ownerItemCodes.value = (record.linked_item_codes || record.item_codes || []).join('\n');
    el.ownerPublicVideoUrl.value = record.public_video_url || '';
    el.ownerEmbedVideoUrl.value = record.embed_video_url || '';
    el.ownerShortQuote.value = record.short_quote || '';
    el.ownerSummary.value = record.testimony_summary || '';
    el.ownerHint.textContent = source === 'owner'
      ? 'Existing owner selected. Save changes or merge the current submission into this owner.'
      : 'Submission copied into a new owner draft. Approve it as a new owner, or select an existing owner to merge.';
  }

  function clearOwnerDraft() {
    el.ownerId.value = '';
    el.ownerSlug.value = '';
    el.ownerDisplayName.value = '';
    el.ownerEmail.value = '';
    el.ownerLocation.value = '';
    el.ownerStatus.value = 'active';
    el.ownerItemCodes.value = '';
    el.ownerPublicVideoUrl.value = '';
    el.ownerEmbedVideoUrl.value = '';
    el.ownerShortQuote.value = '';
    el.ownerSummary.value = '';
    el.replaceOwnerVideoToggle.checked = false;
    state.selectedOwner = null;
    el.ownerHint.textContent = 'Select a submission to prefill a new owner draft, or select an existing owner to merge the submission into that owner.';
    renderOwners();
  }

  function renderStats(summary) {
    const c = summary?.submission_counts || { pending: 0, approved_new_owner: 0, merged_to_existing: 0, rejected: 0 };
    el.statPending.textContent = c.pending || 0;
    el.statApprovedNew.textContent = c.approved_new_owner || 0;
    el.statMerged.textContent = c.merged_to_existing || 0;
    el.statRejected.textContent = c.rejected || 0;
    el.statOwners.textContent = summary?.approved_owners || 0;
    el.statClaimed.textContent = summary?.linked_item_codes || 0;
    el.statDefaultCodes.textContent = summary?.default_item_codes || 0;
  }

  function statusClass(value) {
    if (value === 'pending') return 'pending';
    if (value === 'rejected') return 'rejected';
    if (value === 'merged_to_existing') return 'merged';
    return 'approved';
  }

  function renderQueue() {
    const queue = state.queue;
    if (!queue) return;
    el.queuePill.textContent = `${queue.total} result${queue.total === 1 ? '' : 's'}`;
    el.submissionPageLabel.textContent = `Page ${queue.page} of ${queue.total_pages}`;
    const start = queue.total ? ((queue.page - 1) * queue.page_size) + 1 : 0;
    const end = Math.min(queue.page * queue.page_size, queue.total);
    el.submissionRangeLabel.textContent = `Showing ${start}–${end}`;
    el.selectedCountLabel.textContent = `${state.selectedSubmissionIds.size} selected`;
    el.submissionPrevBtn.disabled = !queue.has_prev;
    el.submissionNextBtn.disabled = !queue.has_next;

    if (!queue.items.length) {
      el.submissionList.innerHTML = '<div class="empty">No submissions match these filters.</div>';
      return;
    }

    el.submissionList.innerHTML = queue.items.map(item => {
      const selected = state.selectedSubmission && state.selectedSubmission.id === item.id ? 'selected' : '';
      const checked = state.selectedSubmissionIds.has(item.id) ? 'checked' : '';
      const codes = (item.item_codes || []).slice(0, 4);
      return `
        <div class="card queue-card ${selected}" data-submission-id="${item.id}">
          <div class="row-between">
            <div class="checkbox-row">
              <input type="checkbox" data-submission-check="${item.id}" ${checked} />
              <div>
                <h4>${esc(item.submitted_name)}</h4>
                <div class="queue-meta">${esc(item.submitted_email || 'No email')} · ${esc(item.location || 'No location')}</div>
              </div>
            </div>
            <span class="pill ${statusClass(item.review_status)}">${esc(item.review_status)}</span>
          </div>
          <button type="button" data-submission-open="${item.id}">
            <div class="queue-meta">${esc(item.short_quote || 'No short quote yet.')}</div>
            <div class="row" style="margin-top:8px">${codes.length ? codes.map(code => `<span class="code">${esc(code)}</span>`).join('') : '<span class="code">No item code</span>'}</div>
            <div class="queue-meta" style="margin-top:8px">Submitted ${esc(item.created_at || '')}</div>
          </button>
        </div>
      `;
    }).join('');

    el.submissionList.querySelectorAll('[data-submission-open]').forEach(btn => {
      btn.addEventListener('click', () => loadSubmissionDetail(btn.dataset.submissionOpen));
    });
    el.submissionList.querySelectorAll('[data-submission-check]').forEach(box => {
      box.addEventListener('change', () => {
        const id = Number(box.dataset.submissionCheck);
        if (box.checked) state.selectedSubmissionIds.add(id);
        else state.selectedSubmissionIds.delete(id);
        el.selectedCountLabel.textContent = `${state.selectedSubmissionIds.size} selected`;
      });
    });
  }

  function renderSubmissionReview() {
    const submission = state.selectedSubmission;
    if (!submission) {
      el.reviewStatusPill.textContent = 'No submission selected';
      el.submissionReview.innerHTML = '<div class="empty">Choose a submission from the queue to review the full details, save notes, approve it, merge it into an existing owner, or reject it.</div>';
      return;
    }

    const linkedOwnerText = submission.linked_owner_name || submission.linked_owner_slug || 'none';
    const suggestedText = submission.suggested_owner_name || submission.suggested_owner_slug || 'none';
    el.reviewStatusPill.innerHTML = `<span class="pill ${statusClass(submission.review_status)}">${esc(submission.review_status)}</span>`;

    el.submissionReview.innerHTML = `
      <div class="card">
        <h3>${esc(submission.submitted_name)}</h3>
        <p class="note"><strong style="color:#fff4cc">Email:</strong> ${esc(submission.submitted_email || '—')}</p>
        <p class="note"><strong style="color:#fff4cc">Location:</strong> ${esc(submission.location || '—')}</p>
        <p class="note"><strong style="color:#fff4cc">Submitted:</strong> ${esc(submission.created_at || '—')}</p>
        <p class="note"><strong style="color:#fff4cc">Suggested owner match:</strong> ${esc(suggestedText)}</p>
        <p class="note"><strong style="color:#fff4cc">Linked owner:</strong> ${esc(linkedOwnerText)}</p>
        <p class="note"><strong style="color:#fff4cc">Item codes:</strong><br>${(submission.item_codes || []).length ? submission.item_codes.map(code => `<span class="code">${esc(code)}</span>`).join(' ') : 'none'}</p>
        <p class="note"><strong style="color:#fff4cc">Short quote:</strong> ${esc(submission.short_quote || '—')}</p>
        <p class="note"><strong style="color:#fff4cc">Summary:</strong> ${esc(submission.testimony_summary || '—')}</p>
        <p class="note"><strong style="color:#fff4cc">Video:</strong> ${submission.public_video_url ? `<a href="${esc(submission.public_video_url)}" target="_blank" rel="noopener">Open public video ↗</a>` : '—'}</p>
        <div class="field" style="margin-top:12px">
          <label>Moderation notes</label>
          <textarea id="submissionAdminNotes">${esc(submission.admin_notes || '')}</textarea>
        </div>
        <div class="submission-actions">
          <button class="btn ghost" id="saveSubmissionNotesBtn">Save notes</button>
          <button class="btn ok" id="approveFromReviewBtn">Approve as new owner</button>
          <button class="btn warn" id="mergeFromReviewBtn">Merge into selected owner</button>
          <button class="btn bad" id="rejectFromReviewBtn">Reject</button>
        </div>
      </div>
    `;

    document.getElementById('saveSubmissionNotesBtn').addEventListener('click', saveSubmissionNotes);
    document.getElementById('approveFromReviewBtn').addEventListener('click', approveAsNewOwner);
    document.getElementById('mergeFromReviewBtn').addEventListener('click', mergeIntoSelectedOwner);
    document.getElementById('rejectFromReviewBtn').addEventListener('click', rejectCurrentSubmission);
  }

  function renderOwners() {
    const owners = state.owners;
    if (!owners) return;
    el.ownerPill.textContent = `${owners.total} owner${owners.total === 1 ? '' : 's'}`;
    el.ownerPageLabel.textContent = `Page ${owners.page} of ${owners.total_pages}`;
    el.ownerPrevBtn.disabled = !owners.has_prev;
    el.ownerNextBtn.disabled = !owners.has_next;

    if (!owners.items.length) {
      el.ownerList.innerHTML = '<div class="empty">No owners found.</div>';
      return;
    }

    el.ownerList.innerHTML = owners.items.map(owner => {
      const selected = state.selectedOwner && state.selectedOwner.id === owner.id ? 'selected' : '';
      return `
        <div class="card owner-card ${selected}" data-owner-id="${owner.id}">
          <button type="button" data-owner-open="${owner.id}">
            <div class="row-between"><h4>${esc(owner.display_name)}</h4><span class="pill">${esc(owner.status)}</span></div>
            <div class="owner-meta">${esc(owner.email || 'No email')} · ${esc(owner.location || 'No location')}</div>
            <div class="owner-meta">${owner.linked_item_codes.length} linked item code(s)</div>
            <div class="owner-meta">/${esc(owner.slug || '')}</div>
          </button>
        </div>
      `;
    }).join('');

    el.ownerList.querySelectorAll('[data-owner-open]').forEach(btn => {
      btn.addEventListener('click', () => loadOwnerDetail(btn.dataset.ownerOpen));
    });
  }

  function renderAudit(logs) {
    el.auditList.innerHTML = logs.length ? logs.map(log => `
      <div class="audit-item">
        <div class="row-between"><strong>${esc(log.action)}</strong><span class="small">${esc(log.created_at)}</span></div>
        <div class="small">${esc(log.entity_type)} · ${esc(log.entity_id)}</div>
      </div>
    `).join('') : '<div class="empty">No audit items yet.</div>';
  }

  async function loadSummary() {
    const query = new URLSearchParams({
      status: state.submissionFilters.status,
      query: state.submissionFilters.query,
      page: String(state.submissionFilters.page),
      page_size: String(state.submissionFilters.pageSize),
      owner_query: state.ownerFilters.query,
      owner_status: state.ownerFilters.status,
      owner_page: String(state.ownerFilters.page),
      owner_page_size: String(state.ownerFilters.pageSize)
    });
    const dashboard = await api(`/api/admin/dashboard?${query.toString()}`);
    state.summary = dashboard.summary;
    state.queue = dashboard.submissions;
    state.owners = dashboard.owners;
    renderStats(state.summary);
    fillFounder(state.summary.founder_defaults);
    renderQueue();
    renderOwners();
  }

  async function loadAudit() {
    const audit = await api('/api/admin/audit-logs?limit=12');
    state.auditLogs = audit.logs || [];
    renderAudit(state.auditLogs);
  }

  async function reloadAll() {
    try {
      await Promise.all([loadSummary(), loadAudit()]);
      renderSubmissionReview();
      setStatus('Dashboard loaded.');
    } catch (error) {
      setStatus(error.message, false);
    }
  }

  async function loadSubmissionDetail(id) {
    try {
      const data = await api(`/api/admin/submissions/${id}`);
      state.selectedSubmission = data.submission;
      if (!el.ownerId.value) fillOwnerDraft(data.submission, 'submission');
      renderQueue();
      renderSubmissionReview();
      setStatus(`Loaded submission #${id}.`);
    } catch (error) {
      setStatus(error.message, false);
    }
  }

  async function loadOwnerDetail(id) {
    try {
      const data = await api(`/api/admin/owners/${id}`);
      state.selectedOwner = data.owner;
      fillOwnerDraft(data.owner, 'owner');
      renderOwners();
      setStatus(`Loaded owner #${id}.`);
    } catch (error) {
      setStatus(error.message, false);
    }
  }

  async function applySubmissionFilters() {
    state.submissionFilters.query = el.submissionQuery.value.trim();
    state.submissionFilters.status = el.submissionStatus.value;
    state.submissionFilters.pageSize = Number(el.submissionPageSize.value);
    state.submissionFilters.page = 1;
    await reloadAll();
  }

  async function searchOwners() {
    state.ownerFilters.query = el.ownerQuery.value.trim();
    state.ownerFilters.status = el.ownerStatusFilter.value;
    state.ownerFilters.pageSize = Number(el.ownerPageSize.value);
    state.ownerFilters.page = 1;
    await reloadAll();
  }

  async function saveSubmissionNotes() {
    try {
      if (!state.selectedSubmission) throw new Error('Select a submission first');
      setButtonLoading(document.getElementById('saveSubmissionNotesBtn'), true, 'Saving...');
      const notes = document.getElementById('submissionAdminNotes').value;
      const data = await api(`/api/admin/submissions/${state.selectedSubmission.id}/notes`, {
        method: 'PATCH',
        body: JSON.stringify({ admin_notes: notes })
      });
      state.selectedSubmission = data.submission;
      renderSubmissionReview();
      await loadAudit();
      setStatus('Moderation notes saved.');
    } catch (error) {
      setStatus(error.message, false);
    }
  }

  async function approveAsNewOwner() {
    const button = document.getElementById('approveFromReviewBtn') || el.approveNewOwnerBtn;
    try {
      if (!state.selectedSubmission) throw new Error('Select a submission first');
      const payload = collectOwnerPayload();
      if (!payload.display_name || !payload.public_video_url) throw new Error('Owner display name and public video URL are required');
      const notes = document.getElementById('submissionAdminNotes')?.value || '';
      setButtonLoading(button, true, 'Approving...');
      await api(`/api/admin/submissions/${state.selectedSubmission.id}/approve-new-owner`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, admin_notes: notes, force_item_reassign: true })
      });
      state.selectedSubmissionIds.delete(state.selectedSubmission.id);
      state.selectedSubmission = null;
      clearOwnerDraft();
      await reloadAll();
      renderSubmissionReview();
      setStatus('Submission approved as a new owner profile.');
    } catch (error) {
      setStatus(error.message, false);
    } finally {
      setButtonLoading(button, false);
    }
  }

  async function mergeIntoSelectedOwner() {
    const button = document.getElementById('mergeFromReviewBtn') || el.mergeIntoOwnerBtn;
    try {
      if (!state.selectedSubmission) throw new Error('Select a submission first');
      const ownerId = Number(el.ownerId.value || state.selectedOwner?.id || 0);
      if (!ownerId) throw new Error('Select an existing owner first');
      const notes = document.getElementById('submissionAdminNotes')?.value || '';
      setButtonLoading(button, true, 'Merging...');
      await api(`/api/admin/submissions/${state.selectedSubmission.id}/link-owner`, {
        method: 'POST',
        body: JSON.stringify({
          owner_id: ownerId,
          admin_notes: notes,
          replace_owner_video: !!el.replaceOwnerVideoToggle.checked,
          force_item_reassign: true
        })
      });
      state.selectedSubmissionIds.delete(state.selectedSubmission.id);
      state.selectedSubmission = null;
      clearOwnerDraft();
      await reloadAll();
      renderSubmissionReview();
      setStatus('Submission merged into selected owner.');
    } catch (error) {
      setStatus(error.message, false);
    } finally {
      setButtonLoading(button, false);
    }
  }

  async function rejectCurrentSubmission() {
    const button = document.getElementById('rejectFromReviewBtn');
    try {
      if (!state.selectedSubmission) throw new Error('Select a submission first');
      const notes = document.getElementById('submissionAdminNotes')?.value || 'Rejected from moderation dashboard';
      setButtonLoading(button, true, 'Rejecting...');
      await api(`/api/admin/submissions/${state.selectedSubmission.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ admin_notes: notes })
      });
      state.selectedSubmissionIds.delete(state.selectedSubmission.id);
      state.selectedSubmission = null;
      await reloadAll();
      renderSubmissionReview();
      setStatus('Submission rejected.');
    } catch (error) {
      setStatus(error.message, false);
    } finally {
      setButtonLoading(button, false);
    }
  }

  async function bulkRejectSelected() {
    try {
      const ids = [...state.selectedSubmissionIds];
      if (!ids.length) throw new Error('Select at least one submission first');
      const notes = window.prompt('Optional note for all rejected submissions:', 'Rejected from moderation dashboard') || '';
      setButtonLoading(el.bulkRejectBtn, true, 'Rejecting...');
      await api('/api/admin/submissions/bulk-reject', {
        method: 'POST',
        body: JSON.stringify({ submission_ids: ids, admin_notes: notes })
      });
      state.selectedSubmissionIds.clear();
      if (state.selectedSubmission && ids.includes(state.selectedSubmission.id)) state.selectedSubmission = null;
      await reloadAll();
      renderSubmissionReview();
      setStatus(`Rejected ${ids.length} selected submission(s).`);
    } catch (error) {
      setStatus(error.message, false);
    } finally {
      setButtonLoading(el.bulkRejectBtn, false);
    }
  }

  async function saveOwner() {
    try {
      const payload = collectOwnerPayload();
      if (!payload.display_name || !payload.public_video_url) throw new Error('Owner display name and public video URL are required');
      setButtonLoading(el.saveOwnerBtn, true, 'Saving...');
      if (el.ownerId.value) {
        await api(`/api/admin/owners/${el.ownerId.value}`, { method: 'PATCH', body: JSON.stringify(payload) });
        await api(`/api/admin/owners/${el.ownerId.value}/link-item-codes`, {
          method: 'POST',
          body: JSON.stringify({ item_codes: payload.item_codes, force_item_reassign: true })
        });
      } else {
        await api('/api/admin/owners', { method: 'POST', body: JSON.stringify({ ...payload, force_item_reassign: true }) });
      }
      await reloadAll();
      setStatus('Owner saved.');
    } catch (error) {
      setStatus(error.message, false);
    } finally {
      setButtonLoading(el.saveOwnerBtn, false);
    }
  }

  async function saveFounderDefault() {
    try {
      setButtonLoading(el.saveFounderBtn, true, 'Saving...');
      await api('/api/admin/settings/founder', {
        method: 'PATCH',
        body: JSON.stringify({
          display_name: el.founderName.value.trim(),
          public_video_url: el.founderPublicVideoUrl.value.trim(),
          embed_video_url: el.founderEmbedVideoUrl.value.trim(),
          short_quote: el.founderShortQuote.value.trim(),
          testimony_summary: el.founderSummary.value.trim(),
          site_base_url: el.siteBaseUrl.value.trim()
        })
      });
      await reloadAll();
      setStatus('Founder default testimony updated.');
    } catch (error) {
      setStatus(error.message, false);
    } finally {
      setButtonLoading(el.saveFounderBtn, false);
    }
  }

  async function importItemCodes() {
    try {
      const itemCodes = parseCodes(el.bulkItemCodes.value);
      if (!itemCodes.length) throw new Error('Enter at least one item code');
      setButtonLoading(el.importItemCodesBtn, true, 'Importing...');
      await api('/api/admin/item-codes/import', {
        method: 'POST',
        body: JSON.stringify({ item_codes: itemCodes })
      });
      el.bulkItemCodes.value = '';
      await reloadAll();
      setStatus(`Imported ${itemCodes.length} item code(s).`);
    } catch (error) {
      setStatus(error.message, false);
    } finally {
      setButtonLoading(el.importItemCodesBtn, false);
    }
  }

  function toggleSelectAllVisible() {
    if (!state.queue) return;
    const visibleIds = state.queue.items.map(item => item.id);
    const allSelected = visibleIds.length && visibleIds.every(id => state.selectedSubmissionIds.has(id));
    visibleIds.forEach(id => {
      if (allSelected) state.selectedSubmissionIds.delete(id);
      else state.selectedSubmissionIds.add(id);
    });
    renderQueue();
  }

  const debouncedOwnerSearch = debounce(searchOwners, 250);

  el.adminKey.value = state.adminKey;
  el.submissionStatus.value = state.submissionFilters.status;
  el.submissionPageSize.value = String(state.submissionFilters.pageSize);
  el.ownerStatusFilter.value = state.ownerFilters.status;
  el.ownerPageSize.value = String(state.ownerFilters.pageSize);

  el.saveKeyBtn.addEventListener('click', () => {
    state.adminKey = el.adminKey.value.trim();
    localStorage.setItem('jimk_admin_key', state.adminKey);
    setStatus(state.adminKey ? 'Admin key saved in this browser.' : 'Admin key cleared.');
  });
  el.reloadAllBtn.addEventListener('click', reloadAll);
  el.reloadAuditBtn.addEventListener('click', loadAudit);
  el.applySubmissionFiltersBtn.addEventListener('click', applySubmissionFilters);
  el.selectAllVisibleBtn.addEventListener('click', toggleSelectAllVisible);
  el.bulkRejectBtn.addEventListener('click', bulkRejectSelected);
  el.submissionPrevBtn.addEventListener('click', async () => {
    if (state.queue?.has_prev) {
      state.submissionFilters.page -= 1;
      await reloadAll();
    }
  });
  el.submissionNextBtn.addEventListener('click', async () => {
    if (state.queue?.has_next) {
      state.submissionFilters.page += 1;
      await reloadAll();
    }
  });
  el.ownerPrevBtn.addEventListener('click', async () => {
    if (state.owners?.has_prev) {
      state.ownerFilters.page -= 1;
      await reloadAll();
    }
  });
  el.ownerNextBtn.addEventListener('click', async () => {
    if (state.owners?.has_next) {
      state.ownerFilters.page += 1;
      await reloadAll();
    }
  });
  el.ownerQuery.addEventListener('input', debouncedOwnerSearch);
  el.ownerStatusFilter.addEventListener('change', searchOwners);
  el.ownerPageSize.addEventListener('change', searchOwners);
  el.saveOwnerBtn.addEventListener('click', saveOwner);
  el.approveNewOwnerBtn.addEventListener('click', approveAsNewOwner);
  el.mergeIntoOwnerBtn.addEventListener('click', mergeIntoSelectedOwner);
  el.clearOwnerDraftBtn.addEventListener('click', clearOwnerDraft);
  el.saveFounderBtn.addEventListener('click', saveFounderDefault);
  el.importItemCodesBtn.addEventListener('click', importItemCodes);
  el.ownerDisplayName.addEventListener('input', () => {
    if (!el.ownerId.value) el.ownerSlug.value = slugify(el.ownerDisplayName.value);
  });
  el.submissionQuery.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applySubmissionFilters();
  });

  if (state.adminKey) reloadAll();
})();
