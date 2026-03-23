/**
 * MemeScanner — Popup Script
 * 
 * Manages the popup dashboard UI:
 * - Polls background for state
 * - Renders watched tokens with live data
 * - Handles filter form
 * - Displays activity logs
 */

(() => {
  'use strict';

  // ─── DOM Elements ───
  const toggleBtn = document.getElementById('toggleBtn');
  const statScanned = document.getElementById('statScanned');
  const statMatched = document.getElementById('statMatched');
  const statRejected = document.getElementById('statRejected');
  const statWatching = document.getElementById('statWatching');
  const watchedList = document.getElementById('watchedList');
  const logList = document.getElementById('logList');
  const uptimeEl = document.getElementById('uptime');

  // Filter inputs
  const filterForm = document.getElementById('filterForm');
  const maxAgeInput = document.getElementById('maxAge');
  const minVolumeInput = document.getElementById('minVolume');
  const minMCInput = document.getElementById('minMC');
  const minTXInput = document.getElementById('minTX');
  const autoOpenInput = document.getElementById('autoOpen');
  const maxTabsInput = document.getElementById('maxTabs');

  // Tab switching
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  let currentState = null;
  let pollInterval = null;

  // ─── Initialize ───
  init();

  function init() {
    setupTabs();
    setupToggle();
    setupFilterForm();
    pollState();
    pollInterval = setInterval(pollState, 2000);
  }

  // ─── Tab Switching ───
  function setupTabs() {
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tabContents.forEach(tc => tc.classList.remove('active'));
        tab.classList.add('active');
        const targetTab = document.getElementById(`tab-${tab.dataset.tab}`);
        if (targetTab) targetTab.classList.add('active');

        // Load logs when switching to logs tab
        if (tab.dataset.tab === 'logs') {
          loadLogs();
        }
      });
    });
  }

  // ─── Toggle Scanner ───
  function setupToggle() {
    toggleBtn.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ type: 'TOGGLE_ENABLED' });
      updateToggle(response.enabled);
    });
  }

  function updateToggle(enabled) {
    if (enabled) {
      toggleBtn.classList.add('active');
    } else {
      toggleBtn.classList.remove('active');
    }
  }

  // ─── Filter Form ───
  function setupFilterForm() {
    filterForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const filters = {
        maxAge: parseInt(maxAgeInput.value) || 0,
        minVolume: parseInt(minVolumeInput.value) || 0,
        minMC: parseInt(minMCInput.value) || 0,
        minTX: parseInt(minTXInput.value) || 0,
        autoOpen: autoOpenInput.checked,
        maxTabs: parseInt(maxTabsInput.value) || 5
      };
      await chrome.runtime.sendMessage({ type: 'UPDATE_FILTERS', filters });
      showSaveConfirmation();
    });
  }

  function showSaveConfirmation() {
    const btn = filterForm.querySelector('.save-btn');
    const original = btn.textContent;
    btn.textContent = '✅ Saved!';
    btn.style.background = 'var(--accent-green)';
    setTimeout(() => {
      btn.textContent = original;
      btn.style.background = '';
    }, 1500);
  }

  // ─── State Polling ───
  async function pollState() {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (state) {
        currentState = state;
        renderState(state);
      }
    } catch (err) {
      // Background may not be ready yet
    }
  }

  function renderState(state) {
    // Toggle
    updateToggle(state.enabled);

    // Stats
    statScanned.textContent = formatNumber(state.stats.totalScanned);
    statMatched.textContent = formatNumber(state.stats.totalMatched);
    statRejected.textContent = formatNumber(state.stats.totalRejected);
    statWatching.textContent = state.stats.currentlyWatching;

    // Uptime
    const uptimeMs = state.stats.uptimeMs || 0;
    uptimeEl.textContent = `Uptime: ${formatUptime(uptimeMs)}`;

    // Populate filter form (only on first load)
    if (state.filters && !filterForm.dataset.loaded) {
      maxAgeInput.value = state.filters.maxAge || '';
      minVolumeInput.value = state.filters.minVolume || '';
      minMCInput.value = state.filters.minMC || '';
      minTXInput.value = state.filters.minTX || '';
      autoOpenInput.checked = state.filters.autoOpen !== false;
      maxTabsInput.value = state.filters.maxTabs || 5;
      filterForm.dataset.loaded = 'true';
    }

    // Watched tokens
    renderWatchedTokens(state.watchedTokens);
  }

  // ─── Render Watched Tokens ───
  function renderWatchedTokens(tokens) {
    if (!tokens || tokens.length === 0) {
      watchedList.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">👀</span>
          <p>No tokens being watched yet</p>
          <p class="empty-sub">Matching tokens will appear here</p>
        </div>
      `;
      return;
    }

    watchedList.innerHTML = tokens.map(token => renderTokenCard(token)).join('');

    // Attach event listeners
    watchedList.querySelectorAll('.btn-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const tokenPath = btn.dataset.path;
        chrome.runtime.sendMessage({ type: 'CLOSE_WATCHED', tokenPath });
      });
    });

    watchedList.querySelectorAll('.btn-open').forEach(btn => {
      btn.addEventListener('click', () => {
        const tokenPath = btn.dataset.path;
        const url = tokenPath.startsWith('http') ? tokenPath : `https://axiom.trade${tokenPath}`;
        chrome.tabs.create({ url, active: true });
      });
    });
  }

  function renderTokenCard(token) {
    const isRugRisk = token.detailData?.isRugRisk;
    const statusClass = isRugRisk ? 'rug-risk' : token.status;
    const statusLabel = isRugRisk ? '🚨 RUG RISK' : token.status.toUpperCase();

    let rugSection = '';
    if (isRugRisk && token.detailData?.rugIndicators?.length) {
      rugSection = `
        <div class="rug-indicators">
          ${token.detailData.rugIndicators.map(r => `<p>⚠️ ${escapeHtml(r)}</p>`).join('')}
        </div>
      `;
    }

    let detailSection = '';
    if (token.detailData) {
      const d = token.detailData;
      detailSection = `
        <div class="token-metrics" style="margin-top: 4px; padding-top: 6px; border-top: 1px solid var(--border);">
          ${d.price ? `<div class="token-metric">Price: <span>${escapeHtml(d.price)}</span></div>` : ''}
          ${d.liquidity ? `<div class="token-metric">Liq: <span>${escapeHtml(d.liquidity)}</span></div>` : ''}
          ${d.holders ? `<div class="token-metric">Holders: <span>${escapeHtml(d.holders)}</span></div>` : ''}
          ${d.topHolderPct ? `<div class="token-metric">Top10: <span>${escapeHtml(d.topHolderPct)}</span></div>` : ''}
        </div>
      `;
    }

    return `
      <div class="token-card">
        <div class="token-card-header">
          <div>
            <span class="token-ticker">${escapeHtml(token.ticker || '???')}</span>
            <span class="token-name">${escapeHtml(token.name || '')}</span>
          </div>
          <span class="token-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="token-metrics">
          <div class="token-metric">Age: <span>${escapeHtml(token.age || '?')}</span></div>
          <div class="token-metric">Vol: <span>${escapeHtml(token.volume || '?')}</span></div>
          <div class="token-metric">MC: <span>${escapeHtml(token.marketCap || '?')}</span></div>
        </div>
        ${detailSection}
        ${rugSection}
        <div class="token-actions">
          <button class="token-btn btn-open" data-path="${escapeHtml(token.tokenPath || '')}">🔗 Open</button>
          <button class="token-btn danger btn-close" data-path="${escapeHtml(token.tokenPath || '')}">✕ Stop</button>
        </div>
      </div>
    `;
  }

  // ─── Logs ───
  async function loadLogs() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
      if (response?.logs) {
        renderLogs(response.logs);
      }
    } catch (err) {
      // ignore
    }
  }

  function renderLogs(logs) {
    if (!logs || logs.length === 0) {
      logList.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📝</span>
          <p>No activity yet</p>
        </div>
      `;
      return;
    }

    logList.innerHTML = logs
      .reverse()
      .map(log => `
        <div class="log-entry">
          <span class="log-time">${escapeHtml(log.time)}</span>
          <span class="log-msg">${escapeHtml(log.message)}</span>
        </div>
      `)
      .join('');
  }

  // ─── Helpers ───
  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
