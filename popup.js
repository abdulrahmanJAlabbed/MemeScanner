(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    activeTab: 'feed',
    latest: null,
    tokenSeries: {}
  };

  const UI = {
    toggle: $('toggleScanner'),
    uptime: $('uptime'),
    hudScanned: $('hudScanned'),
    hudMatched: $('hudMatched'),
    hudRejected: $('hudRejected'),
    hudWatch: $('hudWatch'),
    badgeFeed: $('badgeFeed'),
    badgeWatch: $('badgeWatch'),
    tabsNav: $('tabsNav'),
    feedList: $('feedList'),
    watchList: $('watchList'),
    logsList: $('logsList'),
    settings: {
      liveItemsTarget: $('liveItemsTarget'),
      showAdvancedData: $('showAdvancedData'),
      launchPinned: $('launchPinned'),
      launchInBackground: $('launchInBackground'),
      executionMode: $('executionMode'),
      snipeMaxAgeSeconds: $('snipeMaxAgeSeconds'),
      snipeMinVelocity: $('snipeMinVelocity'),
      snipeMaxTop10Pct: $('snipeMaxTop10Pct'),
      snipeAmountUsd: $('snipeAmountUsd'),
      saveButton: $('saveSettings')
    }
  };

  function toNumberOr(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Number(seconds || 0));
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  async function request(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    return response || { ok: false };
  }

  async function syncState() {
    const response = await request('GET_STATE');
    if (!response.ok) {
      return;
    }

    state.latest = response;
    updateTokenSeries(response.marketFeed || {}, response.watchlist || {});
    paintHud(response.hud, response.settings);
    paintBadges(response);
    hydrateSettings(response.settings);
    renderActiveTab();
  }

  function parseCompactValue(text) {
    const cleaned = String(text || '').trim().replace(/[$,]/g, '').toUpperCase();
    const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(K|M|B|T)?$/);
    if (!match) return 0;
    const value = Number(match[1]);
    const suffix = match[2] || '';
    if (suffix === 'K') return value * 1_000;
    if (suffix === 'M') return value * 1_000_000;
    if (suffix === 'B') return value * 1_000_000_000;
    if (suffix === 'T') return value * 1_000_000_000_000;
    return value;
  }

  function updateTokenSeries(feedMap, watchMap) {
    const mergedMap = {
      ...(feedMap || {}),
      ...(watchMap || {})
    };

    const activeIds = new Set(Object.keys(mergedMap));
    for (const tokenId of Object.keys(state.tokenSeries)) {
      if (!activeIds.has(tokenId)) {
        delete state.tokenSeries[tokenId];
      }
    }

    for (const [tokenId, token] of Object.entries(mergedMap)) {
      const marketCapValue = parseCompactValue(token?.marketCap || '0');
      if (!marketCapValue) {
        continue;
      }

      const series = state.tokenSeries[tokenId] || [];
      const lastPoint = series[series.length - 1];
      if (lastPoint !== marketCapValue || series.length < 2) {
        series.push(marketCapValue);
      }
      if (series.length > 40) {
        series.shift();
      }
      state.tokenSeries[tokenId] = series;
    }
  }

  function drawSparkline(canvas, points) {
    if (!canvas || !Array.isArray(points)) {
      return;
    }

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssWidth = canvas.clientWidth || 118.7;
    const cssHeight = canvas.clientHeight || 40;
    const width = Math.floor(cssWidth * dpr);
    const height = Math.floor(cssHeight * dpr);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.clearRect(0, 0, width, height);
    if (points.length < 2) {
      return;
    }

    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = Math.max(1, max - min);
    const padX = 6 * dpr;
    const padY = 5 * dpr;
    const usableWidth = width - padX * 2;
    const usableHeight = height - padY * 2;

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#14f195');
    gradient.addColorStop(1, '#9c7dff');

    ctx.lineWidth = Math.max(1.5, 1.8 * dpr);
    ctx.strokeStyle = gradient;
    ctx.beginPath();

    points.forEach((point, index) => {
      const x = padX + (usableWidth * index) / (points.length - 1);
      const y = padY + usableHeight - ((point - min) / range) * usableHeight;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    const last = Number(points[points.length - 1] || 0);
    const prev = Number(points[points.length - 2] || last);
    const up = last >= prev;
    ctx.fillStyle = up ? 'rgba(20,241,149,0.9)' : 'rgba(255,92,119,0.9)';
    ctx.beginPath();
    ctx.arc(width - padX, padY + usableHeight - ((last - min) / range) * usableHeight, 2.4 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTokenCharts(container) {
    const canvases = container.querySelectorAll('canvas.coin-chart[data-token-id]');
    canvases.forEach((canvas) => {
      const tokenId = canvas.dataset.tokenId;
      if (!tokenId) {
        return;
      }
      const series = state.tokenSeries[tokenId] || [];
      drawSparkline(canvas, series);
    });
  }

  function paintHud(hud, settings) {
    UI.hudScanned.textContent = String(hud.totalScanned || 0);
    UI.hudMatched.textContent = String(hud.totalMatched || 0);
    UI.hudRejected.textContent = String(hud.totalRejected || 0);
    UI.hudWatch.textContent = String(hud.watchCount || 0);
    UI.uptime.textContent = formatClock(hud.uptimeSeconds || 0);

    UI.toggle.classList.toggle('enabled', !!settings.enabled);
    UI.toggle.setAttribute('aria-pressed', String(!!settings.enabled));
  }

  function paintBadges(next) {
    UI.badgeFeed.textContent = String(Object.keys(next.marketFeed || {}).length);
    UI.badgeWatch.textContent = String(Object.keys(next.watchlist || {}).length);
  }

  function hydrateSettings(settings) {
    if (UI.settings.saveButton.dataset.bound === '1') {
      return;
    }

    UI.settings.liveItemsTarget.value = String(settings.liveItemsTarget || 10);
    UI.settings.showAdvancedData.checked = settings.showAdvancedData !== false;
    UI.settings.launchPinned.checked = !!settings.launchPinned;
    UI.settings.launchInBackground.checked = !!settings.launchInBackground;
    UI.settings.executionMode.value = settings.executionMode || 'paper';
    UI.settings.snipeMaxAgeSeconds.value = String(toNumberOr(settings.snipeFilters?.maxAgeSeconds, 120));
    UI.settings.snipeMinVelocity.value = String(toNumberOr(settings.snipeFilters?.minVelocity, 0.03));
    UI.settings.snipeMaxTop10Pct.value = String(toNumberOr(settings.snipeFilters?.maxTop10Pct, 15));
    UI.settings.snipeAmountUsd.value = String(toNumberOr(settings.snipeFilters?.amountUsd, 100));
    UI.settings.saveButton.dataset.bound = '1';
  }

  function renderActiveTab() {
    const data = state.latest;
    if (!data) {
      return;
    }

    const feed = Object.values(data.marketFeed || {}).sort((a, b) => {
      const hostA = String(a.sourceHost || '');
      const hostB = String(b.sourceHost || '');
      if (hostA !== hostB) {
        return hostA.localeCompare(hostB);
      }

      const orderA = Number.isFinite(Number(a.pageOrder)) ? Number(a.pageOrder) : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(Number(b.pageOrder)) ? Number(b.pageOrder) : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) {
        return orderA - orderB;
      }

      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const watch = Object.values(data.watchlist || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (state.activeTab === 'feed') {
      renderTokenList(UI.feedList, feed, 'feed');
      return;
    }
    if (state.activeTab === 'watchlist') {
      renderTokenList(UI.watchList, watch, 'watch');
      return;
    }
    if (state.activeTab === 'logs') {
      renderLogs(UI.logsList, data.logs || []);
    }
  }

  function renderTokenList(container, tokens, context) {
    if (!tokens.length) {
      container.innerHTML = '<div class="empty">No tokens available.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    tokens.forEach((token) => {
      const advancedEnabled = state.latest?.settings?.showAdvancedData !== false;
      const card = document.createElement('article');
      card.className = 'card';
      card.innerHTML = `
        <div class="card-head">
          <div class="pair">
            <strong class="ticker mono">${escapeHtml(token.ticker || 'UNKNOWN')}</strong>
            <span class="name">${escapeHtml(token.name || token.platform || '')}</span>
          </div>
        </div>
        <div class="name">${token.matchesFilters === false ? 'Filtered Out (included by scope=all)' : 'Filter Matched'}</div>
        <div class="coin-chart-wrap" aria-hidden="true">
          <canvas class="coin-chart" data-token-id="${escapeHtml(token.tokenId)}" role="img"></canvas>
        </div>
        <div class="metrics mono">
          <div class="metric"><span>Market Cap</span><strong>${escapeHtml(token.marketCap || '—')}</strong></div>
          <div class="metric"><span>Liquidity</span><strong>${escapeHtml(token.liquidity || '—')}</strong></div>
          <div class="metric"><span>Volume</span><strong>${escapeHtml(token.volume || '—')}</strong></div>
        </div>
        ${advancedEnabled ? renderAdvancedDetails(token) : ''}
        <div class="actions">
          <button class="secondary" data-action="watch" data-token-id="${escapeHtml(token.tokenId)}">${context === 'watch' ? 'Unwatch' : 'Watch'}</button>
          <button class="primary" data-action="buy" data-token-id="${escapeHtml(token.tokenId)}">Buy</button>
        </div>
      `;
      card.dataset.tokenId = token.tokenId;
      fragment.appendChild(card);
    });

    container.innerHTML = '';
    container.appendChild(fragment);
    drawTokenCharts(container);
  }

  function renderAdvancedDetails(token) {
    // Determine which extra fields are available (GMGN cards provide more data)
    const hasGmgnData = !!(token.smartMoney || token.netFlow || token.twitterHandle || token.watchers);

    let html = `
      <div class="metrics mono" style="margin-top:8px;">
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">📈</span>TXNS</span><strong>${escapeHtml(token.txTotal || '—')}${token.buyRatio ? ` (${escapeHtml(token.buyRatio)} buy)` : ''}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">⚖️</span>Buys/Sells</span><strong>${escapeHtml([token.txBuys || '—', token.txSells || '—'].join('/'))}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">👑</span>Top Holders</span><strong>${escapeHtml(token.topHolders || token.top10Pct || '—')}</strong></div>
      </div>
      <div class="metrics mono" style="margin-top:8px;">
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">📦</span>Bundlers</span><strong>${escapeHtml(token.bundlePct || token.bundlersPct || '—')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">🧑‍💻</span>Dev/Insider</span><strong>${escapeHtml(token.insiderPct || token.devPct || '—')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">🎯</span>Snipers/Bots</span><strong>${escapeHtml([token.sniperPct || '—', token.botCount || token.botPct || '—'].join('/'))}</strong></div>
      </div>
      <div class="metrics mono" style="margin-top:8px;">
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">👥</span>Holders</span><strong>${escapeHtml(token.holders || '—')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">🧠</span>Pro Traders</span><strong>${escapeHtml(token.proTraders || '—')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">✅</span>DEX Paid</span><strong>${escapeHtml(token.dexPaid || '—')}</strong></div>
      </div>`;

    if (hasGmgnData) {
      html += `
      <div class="metrics mono" style="margin-top:8px;">
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">💎</span>Smart $</span><strong>${escapeHtml(token.smartMoney || '0')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">🔥</span>KOL/Degen</span><strong>${escapeHtml(token.smartDegen || '0')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">👁</span>Watchers</span><strong>${escapeHtml(token.watchers || '0')}</strong></div>
      </div>
      <div class="metrics mono" style="margin-top:8px;">
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">💰</span>Net Flow</span><strong>${escapeHtml(token.netFlow || '—')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">🏦</span>Funding</span><strong>${escapeHtml(token.funding || '—')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">☁️</span>Dev Sold</span><strong>${escapeHtml(token.devSoldAge || '—')}</strong></div>
      </div>`;

      if (token.twitterHandle) {
        html += `
      <div class="metrics mono" style="margin-top:8px;">
        <div class="metric" style="flex:2"><span class="metric-label"><span class="metric-icon" aria-hidden="true">🐦</span>Twitter</span><strong>${escapeHtml(token.twitterHandle)}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">👤</span>Followers</span><strong>${escapeHtml(token.twitterFollowers || '0')}</strong></div>
      </div>`;
      }

      html += `
      <div class="metrics mono" style="margin-top:8px;">
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">🐀</span>Rat %</span><strong>${escapeHtml(token.ratPct || '—')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">💎</span>BlueChip</span><strong>${escapeHtml(token.bluechipPct || '—')}</strong></div>
        <div class="metric"><span class="metric-label"><span class="metric-icon" aria-hidden="true">💬</span>Replies</span><strong>${escapeHtml(token.pumpReplies || '—')}</strong></div>
      </div>`;
    }

    return html;
  }

  function renderLogs(container, logs) {
    if (!logs.length) {
      container.innerHTML = '<div class="empty">No logs yet.</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    logs.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'log-line';
      const stamp = new Date(entry.at || Date.now()).toLocaleTimeString();
      row.textContent = `[${stamp}] ${entry.message || ''}`;
      fragment.appendChild(row);
    });

    container.innerHTML = '';
    container.appendChild(fragment);
  }

  function getTokenById(tokenId) {
    if (!state.latest || !tokenId) {
      return null;
    }
    return state.latest.marketFeed?.[tokenId] || state.latest.watchlist?.[tokenId] || null;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function activateTab(targetTab) {
    state.activeTab = targetTab;
    document.querySelectorAll('.tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === targetTab);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${targetTab}`);
    });
    renderActiveTab();
  }

  function bindEvents() {
    UI.tabsNav.addEventListener('click', (event) => {
      const tab = event.target.closest('.tab');
      if (!tab) {
        return;
      }
      activateTab(tab.dataset.tab);
    });

    UI.toggle.addEventListener('click', async () => {
      await request('TOGGLE_SCANNER');
      await syncState();
    });

    document.body.addEventListener('click', async (event) => {
      const clearButton = event.target.closest('[data-clear]');
      if (clearButton) {
        await request('CLEAR_LIST', { target: clearButton.dataset.clear });
        await syncState();
        return;
      }

      const actionButton = event.target.closest('[data-action]');
      if (actionButton) {
        const tokenId = actionButton.dataset.tokenId;
        const action = actionButton.dataset.action;

        if (action === 'watch') {
          const token = getTokenById(tokenId);
          if (token) {
            await request('TOGGLE_WATCH', { token });
          }
        }

        if (action === 'buy') {
          const token = getTokenById(tokenId);
          if (token) {
            const usd = Number(state.latest?.settings?.defaultPositionUsd || 100);
            await request('SIM_BUY', { token, amountUsd: usd });
          }
        }

        await syncState();
        return;
      }

      const dockButton = event.target.closest('.dock-link');
      if (dockButton) {
        await request('OPEN_PLATFORM', { url: dockButton.dataset.url });
      }
    });

    UI.settings.saveButton.addEventListener('click', async () => {
      await request('UPSERT_SETTINGS', {
        payload: {
          liveItemsTarget: Number(UI.settings.liveItemsTarget.value || 10),
          showAdvancedData: !!UI.settings.showAdvancedData.checked,
          launchPinned: !!UI.settings.launchPinned.checked,
          launchInBackground: !!UI.settings.launchInBackground.checked,
          executionMode: UI.settings.executionMode.value === 'live' ? 'live' : 'paper',
          snipeFilters: {
            maxAgeSeconds: toNumberOr(UI.settings.snipeMaxAgeSeconds.value, 120),
            minVelocity: toNumberOr(UI.settings.snipeMinVelocity.value, 0.03),
            maxTop10Pct: toNumberOr(UI.settings.snipeMaxTop10Pct.value, 15),
            amountUsd: toNumberOr(UI.settings.snipeAmountUsd.value, 100)
          }
        }
      });
      await syncState();
    });
  }

  bindEvents();
  syncState();
  setInterval(syncState, 700);
})();
