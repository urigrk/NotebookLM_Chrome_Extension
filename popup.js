// ────────────────────────────────────────────
//  NotebookLM Extension – popup.js
//  Features: cache, search, smart refresh,
//            recent notebooks, inline upload,
//            pending-link mode (context menu)
// ────────────────────────────────────────────

const CACHE_KEY = 'nlm_notebooks';
const RECENT_KEY = 'nlm_recent';
const MAX_RECENT = 3;
const PENDING_KEY = 'nlm_pending_link';

let allNotebooks = [];
let selectedNotebook = null;
let pendingLink = null;   // set when opened via context-menu "More…"

// ── DOM refs ──
const els = {
  list: () => document.getElementById('notebook-list'),
  search: () => document.getElementById('search'),
  badge: () => document.getElementById('tab-badge'),
  refresh: () => document.getElementById('btn-refresh'),
  statusText: () => document.getElementById('status-text'),
  statusCount: () => document.getElementById('status-count'),
};

// ────────────────────────────────────────────
//  Bootstrap
// ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Check if opened with a pending link from context menu
  const params = new URLSearchParams(window.location.search);
  if (params.get('pending') === '1') {
    const data = await chrome.storage.local.get(PENDING_KEY);
    if (data[PENDING_KEY]) {
      pendingLink = data[PENDING_KEY];
      showPendingBanner(pendingLink);
    }
  }

  updateTabBadge();
  const cached = await loadCache();
  if (cached && cached.length > 0) {
    allNotebooks = cached;
    renderList();
    els.statusText().textContent = pendingLink ? 'Choose a notebook' : 'Loaded from cache';
  } else {
    showEmpty('first');
  }

  // Bindings
  els.refresh().addEventListener('click', () => syncNotebooks());
  els.search().addEventListener('input', onSearch);

  // Auto-sync on popup open
  syncNotebooks();
});

// ────────────────────────────────────────────
//  Tab badge
// ────────────────────────────────────────────
async function updateTabBadge() {
  const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
  const valid = tabs.filter(t => t.url && t.url.startsWith('http'));
  const badge = els.badge();
  badge.textContent = `${valid.length} tab${valid.length !== 1 ? 's' : ''}`;
  badge.classList.toggle('many', valid.length >= 3);
}

// ────────────────────────────────────────────
//  Cache (chrome.storage.local)
// ────────────────────────────────────────────
async function loadCache() {
  return new Promise(resolve => {
    chrome.storage.local.get(CACHE_KEY, data => resolve(data[CACHE_KEY] || null));
  });
}
function saveCache(notebooks) {
  chrome.storage.local.set({ [CACHE_KEY]: notebooks });
}

// ── Recents ──
async function loadRecents() {
  return new Promise(resolve => {
    chrome.storage.local.get(RECENT_KEY, data => resolve(data[RECENT_KEY] || []));
  });
}
function pushRecent(id) {
  loadRecents().then(recents => {
    recents = recents.filter(r => r !== id);
    recents.unshift(id);
    if (recents.length > MAX_RECENT) recents.length = MAX_RECENT;
    chrome.storage.local.set({ [RECENT_KEY]: recents });
  });
}

// ────────────────────────────────────────────
//  Sync (fetch + smart diff)
// ────────────────────────────────────────────
async function syncNotebooks() {
  const btn = els.refresh();
  btn.classList.add('spinning');
  els.statusText().textContent = 'Syncing';
  els.statusText().classList.add('loading-dots');

  chrome.runtime.sendMessage({ action: 'fetchData' }, async (response) => {
    btn.classList.remove('spinning');
    els.statusText().classList.remove('loading-dots');

    if (!response.success) {
      els.statusText().textContent = 'Error: ' + response.error;
      return;
    }

    const fresh = response.notebooks;

    if (allNotebooks.length === 0) {
      // First load
      allNotebooks = fresh;
      saveCache(fresh);
      renderList();
    } else {
      // Smart diff
      smartMerge(fresh);
      saveCache(allNotebooks);
    }

    els.statusText().textContent = 'Synced just now';
  });
}

function smartMerge(freshList) {
  const oldMap = new Map(allNotebooks.map(nb => [nb.id, nb]));
  const freshMap = new Map(freshList.map(nb => [nb.id, nb]));

  // Remove deleted notebooks
  const removedIds = [];
  allNotebooks.forEach(nb => {
    if (!freshMap.has(nb.id)) removedIds.push(nb.id);
  });
  removedIds.forEach(id => {
    const card = document.querySelector(`.nb-card[data-id="${id}"]`);
    if (card) {
      const panel = card.nextElementSibling;
      card.style.transition = 'opacity 0.3s, max-height 0.3s';
      card.style.opacity = '0';
      card.style.maxHeight = '0';
      setTimeout(() => {
        card.remove();
        if (panel && panel.classList.contains('upload-panel')) panel.remove();
      }, 300);
    }
  });
  allNotebooks = allNotebooks.filter(nb => freshMap.has(nb.id));

  // Update changed notebooks
  allNotebooks.forEach((nb, i) => {
    const fresh = freshMap.get(nb.id);
    if (!fresh) return;
    let changed = false;
    if (nb.title !== fresh.title) { nb.title = fresh.title; changed = true; }
    if (nb.emoji !== fresh.emoji) { nb.emoji = fresh.emoji; changed = true; }
    if (nb.sourceCount !== fresh.sourceCount) { nb.sourceCount = fresh.sourceCount; changed = true; }
    if (changed) {
      const card = document.querySelector(`.nb-card[data-id="${nb.id}"]`);
      if (card) {
        card.querySelector('.nb-title').textContent = nb.title;
        card.querySelector('.emoji').textContent = nb.emoji;
        card.querySelector('.nb-meta').textContent = `${nb.sourceCount} sources`;
        card.classList.add('updating');
        setTimeout(() => card.classList.remove('updating'), 500);
      }
    }
  });

  // Add new notebooks
  freshList.forEach(fresh => {
    if (!oldMap.has(fresh.id)) {
      allNotebooks.push(fresh);
      appendCard(fresh, false);
    }
  });

  updateStatusCount();
}

// ────────────────────────────────────────────
//  Render
// ────────────────────────────────────────────
async function renderList() {
  const listEl = els.list();
  listEl.innerHTML = '';

  const recents = await loadRecents();
  const recentSet = new Set(recents);

  // Sort: recents first (in stored order), then rest alphabetically
  const recentNbs = recents.map(id => allNotebooks.find(nb => nb.id === id)).filter(Boolean);
  const restNbs = allNotebooks
    .filter(nb => !recentSet.has(nb.id))
    .sort((a, b) => a.title.localeCompare(b.title));

  if (recentNbs.length > 0) {
    const lbl = document.createElement('div');
    lbl.className = 'section-label';
    lbl.textContent = 'Recent';
    listEl.appendChild(lbl);
    recentNbs.forEach(nb => appendCard(nb, true));
  }

  if (restNbs.length > 0) {
    const lbl = document.createElement('div');
    lbl.className = 'section-label';
    lbl.textContent = recentNbs.length > 0 ? 'All notebooks' : 'Notebooks';
    listEl.appendChild(lbl);
    restNbs.forEach(nb => appendCard(nb, false));
  }

  updateStatusCount();
}

function appendCard(nb, isRecent) {
  const listEl = els.list();

  // Card
  const card = document.createElement('div');
  card.className = 'nb-card' + (isRecent ? ' recent-marker' : '');
  card.dataset.id = nb.id;
  card.style.animationDelay = `${listEl.querySelectorAll('.nb-card').length * 30}ms`;
  card.innerHTML = `
    <span class="emoji">${nb.emoji}</span>
    <div class="info">
      <div class="nb-title">${nb.title}</div>
      <div class="nb-meta">${nb.sourceCount} sources</div>
    </div>
    <span class="arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>
  `;

  // Upload panel (inline, hidden)
  const panel = document.createElement('div');
  panel.className = 'upload-panel';
  panel.dataset.id = nb.id;
  panel.innerHTML = `
    <div class="panel-title"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>Upload selected tabs</div>
    <div class="tab-list" id="tabs-${nb.id}"></div>
    <button class="btn-upload" id="upload-${nb.id}">Upload to Notebook</button>
    <div class="upload-status" id="upload-status-${nb.id}"></div>
  `;

  card.addEventListener('click', () => toggleCard(nb, card, panel));
  panel.querySelector('.btn-upload').addEventListener('click', (e) => {
    e.stopPropagation();
    doUpload(nb, panel);
  });

  listEl.appendChild(card);
  listEl.appendChild(panel);
}

async function toggleCard(nb, card, panel) {
  // ── Pending-link mode: upload directly on click ──
  if (pendingLink) {
    doPendingUpload(nb, card);
    return;
  }

  const wasSelected = card.classList.contains('selected');

  // Close any open panel
  document.querySelectorAll('.nb-card.selected').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.upload-panel.open').forEach(p => p.classList.remove('open'));

  if (wasSelected) {
    selectedNotebook = null;
    return;
  }

  selectedNotebook = nb;
  card.classList.add('selected');

  // Populate tabs
  const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
  const valid = tabs.filter(t => t.url && t.url.startsWith('http'));

  const tabListEl = panel.querySelector('.tab-list');
  const uploadBtn = panel.querySelector('.btn-upload');
  const statusEl = panel.querySelector('.upload-status');
  tabListEl.innerHTML = '';
  statusEl.textContent = '';
  statusEl.className = 'upload-status';

  if (valid.length === 0) {
    tabListEl.innerHTML = '<div class="no-tabs-msg">No web tabs selected.<br>Ctrl+Click tabs to select multiple.</div>';
    uploadBtn.disabled = true;
  } else {
    valid.forEach(tab => {
      const item = document.createElement('div');
      item.className = 'tab-item';
      item.innerHTML = `
        <img src="${tab.favIconUrl || ''}" onerror="this.style.display='none'">
        <span class="tab-title" title="${tab.url}">${tab.title || tab.url}</span>
      `;
      tabListEl.appendChild(item);
    });
    uploadBtn.disabled = false;
    uploadBtn.textContent = `Upload ${valid.length} tab${valid.length !== 1 ? 's' : ''}`;
  }

  panel.classList.add('open');

  // Scroll card into view
  setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
}

// ────────────────────────────────────────────
//  Upload
// ────────────────────────────────────────────
async function doUpload(nb, panel) {
  const btn = panel.querySelector('.btn-upload');
  const statusEl = panel.querySelector('.upload-status');

  const tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
  const urls = tabs.filter(t => t.url && t.url.startsWith('http')).map(t => t.url);

  if (urls.length === 0) {
    statusEl.textContent = 'No valid tabs selected.';
    statusEl.className = 'upload-status error';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Uploading...';
  statusEl.textContent = '';

  chrome.runtime.sendMessage(
    { action: 'uploadLinks', notebookId: nb.id, urls },
    (response) => {
      btn.disabled = false;
      if (response.success) {
        statusEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>${response.count} link${response.count !== 1 ? 's' : ''} uploaded!`;
        statusEl.className = 'upload-status success';
        btn.textContent = 'Done!';
        pushRecent(nb.id);

        // Update source count locally
        const existing = allNotebooks.find(n => n.id === nb.id);
        if (existing) {
          existing.sourceCount += response.count;
          const meta = document.querySelector(`.nb-card[data-id="${nb.id}"] .nb-meta`);
          if (meta) meta.textContent = `${existing.sourceCount} sources`;
          saveCache(allNotebooks);
        }
      } else {
        statusEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>${response.error}`;
        statusEl.className = 'upload-status error';
        btn.textContent = 'Retry';
      }
    }
  );
}

// ────────────────────────────────────────────
//  Search / filter
// ────────────────────────────────────────────
function onSearch() {
  const q = els.search().value.toLowerCase().trim();
  const cards = document.querySelectorAll('.nb-card');
  const labels = document.querySelectorAll('.section-label');

  cards.forEach(card => {
    const title = card.querySelector('.nb-title').textContent.toLowerCase();
    card.classList.toggle('hidden', q.length > 0 && !title.includes(q));
  });

  // Hide section labels if all their cards are hidden
  labels.forEach(lbl => {
    let next = lbl.nextElementSibling;
    let anyVisible = false;
    while (next && !next.classList.contains('section-label')) {
      if (next.classList.contains('nb-card') && !next.classList.contains('hidden')) {
        anyVisible = true;
        break;
      }
      next = next.nextElementSibling;
    }
    lbl.style.display = anyVisible ? '' : 'none';
  });

  updateStatusCount();
}

// ────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────
function updateStatusCount() {
  const total = allNotebooks.length;
  const visible = document.querySelectorAll('.nb-card:not(.hidden)').length;
  els.statusCount().textContent = visible < total ? `${visible}/${total}` : `${total}`;
  els.statusText().textContent = total === 0 ? 'No notebooks' : `${total} notebook${total !== 1 ? 's' : ''}`;
}

function showEmpty(type) {
  const listEl = els.list();
  if (type === 'first') {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg></div>
        <div class="msg">No cached notebooks yet</div>
        <div class="hint">Hit sync to fetch your notebooks</div>
        <button class="btn-fetch" id="btn-first-sync">Sync Notebooks</button>
      </div>
    `;
    document.getElementById('btn-first-sync').addEventListener('click', () => syncNotebooks());
    els.statusText().textContent = 'Ready';
  }
  els.statusCount().textContent = '';
}

// ────────────────────────────────────────────
//  Pending-link mode (context menu → More…)
// ────────────────────────────────────────────
function showPendingBanner(url) {
  // Insert a banner right before the notebook list
  const banner = document.createElement('div');
  banner.id = 'pending-banner';
  banner.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
    <div class="pending-info">
      <span class="pending-label">Upload link</span>
      <span class="pending-url" title="${url}">${url}</span>
    </div>
    <button class="pending-close" title="Cancel">X</button>
  `;
  banner.querySelector('.pending-close').addEventListener('click', () => {
    pendingLink = null;
    chrome.storage.local.remove(PENDING_KEY);
    banner.remove();
    els.statusText().textContent = `${allNotebooks.length} notebooks`;
  });

  const listEl = els.list();
  listEl.parentNode.insertBefore(banner, listEl);
}

async function doPendingUpload(nb, card) {
  // Disable further clicks
  const meta = card.querySelector('.nb-meta');
  const origMeta = meta.textContent;
  card.classList.add('selected');
  meta.textContent = 'Uploading…';
  meta.classList.add('loading-dots');

  chrome.runtime.sendMessage(
    { action: 'uploadLinks', notebookId: nb.id, urls: [pendingLink] },
    (response) => {
      meta.classList.remove('loading-dots');
      if (response.success) {
        meta.textContent = '✓ Uploaded!';
        card.classList.remove('selected');
        card.classList.add('updating');
        pushRecent(nb.id);

        // Update source count
        const existing = allNotebooks.find(n => n.id === nb.id);
        if (existing) {
          existing.sourceCount += 1;
          saveCache(allNotebooks);
        }

        // Clean up pending state
        chrome.storage.local.remove(PENDING_KEY);
        const banner = document.getElementById('pending-banner');
        if (banner) banner.remove();
        pendingLink = null;

        setTimeout(() => {
          meta.textContent = existing
            ? `${existing.sourceCount} sources`
            : origMeta;
          card.classList.remove('updating');
          els.statusText().textContent = 'Link uploaded!';
        }, 1500);
      } else {
        meta.textContent = '✗ Failed';
        card.classList.remove('selected');
        setTimeout(() => {
          meta.textContent = origMeta;
          els.statusText().textContent = response.error || 'Upload failed';
        }, 2000);
      }
    }
  );
}