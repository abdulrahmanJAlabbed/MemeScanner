/**
 * MemeScanner Pro — MV3 service worker.
 *
 * MV3 choice notes:
 * 1) No long-lived in-memory source of truth: all critical state is in chrome.storage.local.
 * 2) Every message is processed independently so worker suspension does not corrupt state.
 * 3) Uptime is derived from timestamps (not setInterval), which remains accurate across sleep/wake.
 */

importScripts('utils.js');

const KEYS = {
  settings: 'settings',
  hud: 'hud',
  watchlist: 'watchlist',
  positions: 'positions',
  marketFeed: 'marketFeed',
  logs: 'logs',
  trackedTabs: 'trackedTabs',
  trackedTargets: 'trackedTargets',
  filterDecisions: 'filterDecisions'
};

const MAX_LOGS = 200;
const MAX_FEED_ITEMS = 220;
const openPlatformLocks = new Map();
const PLATFORM_LOCK_STALE_MS = 3000;
const SCAN_ALARM = 'memeScannerScanKick';
const LOCAL_IPC_URL = 'ws://127.0.0.1:8080';
const LOCAL_IPC_AUTH_TOKEN = 'local-dev-ipc-token';
const TRACKED_TARGET_TTL_MS = 30 * 60 * 1000;

let localIpcSocket = null;
let localIpcReady = false;
let localIpcConnecting = false;

const DEFAULT_SETTINGS = {
  enabled: true,
  refreshMs: 700,
  defaultPositionUsd: 100,
  showAdvancedData: true,
  liveItemsTarget: 10,
  launchPinned: false,
  launchInBackground: false,
  filters: {
    searchKeywords: [],
    excludeKeywords: [],
    protocols: {
      pump: true,
      raydium: true,
      moonshot: true,
      mayhem: true,
      bags: true,
      virtualCurve: true
    },
    age: { min: 0, max: 120, unit: 'minutes' },
    marketCap: { min: 0, max: 0 },
    liquidity: { min: 0, max: 0 },
    volume: { min: 0, max: 0 }
  },
  filterPlan: 'balanced',
  executionMode: 'paper',
  snipeFilters: {
    maxAgeSeconds: 120,
    minVelocity: 0.03,
    maxTop10Pct: 15,
    amountUsd: 100
  }
};

function parseAgeToSeconds(text) {
  const cleaned = String(text || '').trim().toLowerCase();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  if (unit === 's') return value;
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 3600;
  if (unit === 'd') return value * 86400;
  return Number.POSITIVE_INFINITY;
}

function parsePercent(text) {
  const match = String(text || '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return Number.NaN;
  return Number(match[0]);
}

function estimateVelocity(token) {
  const buys = Number(token?.txBuys || 0);
  const sells = Number(token?.txSells || 0);
  const total = Number(token?.txTotal || buys + sells || 0);
  const ageSeconds = parseAgeToSeconds(token?.age || '');
  if (!Number.isFinite(ageSeconds) || ageSeconds <= 0) return 0;
  const directional = Number.isFinite(total) && total > 0 ? Math.max(0, (buys - sells) / total) : 0;
  return directional * (total / ageSeconds);
}

function passesSnipeFilters(token, snipeFilters) {
  const maxAgeSeconds = Number.isFinite(Number(snipeFilters?.maxAgeSeconds)) ? Number(snipeFilters.maxAgeSeconds) : 120;
  const minVelocity = Number.isFinite(Number(snipeFilters?.minVelocity)) ? Number(snipeFilters.minVelocity) : 0.03;
  const maxTop10Pct = Number.isFinite(Number(snipeFilters?.maxTop10Pct)) ? Number(snipeFilters.maxTop10Pct) : 15;

  const ageSeconds = parseAgeToSeconds(token?.age || '');
  const top10Pct = parsePercent(token?.top10Pct || token?.topHolders || '');
  const velocity = estimateVelocity(token);

  const ageOk = Number.isFinite(ageSeconds) && ageSeconds <= maxAgeSeconds;
  const top10Ok = Number.isFinite(top10Pct) && top10Pct <= maxTop10Pct;
  const velocityOk = Number.isFinite(velocity) && velocity >= minVelocity;

  return {
    passed: ageOk && top10Ok && velocityOk,
    ageSeconds,
    top10Pct,
    velocity
  };
}

const DEFAULT_HUD = {
  totalScanned: 0,
  totalMatched: 0,
  totalRejected: 0,
  feedCount: 0,
  openPositions: 0,
  watchCount: 0,
  startedAt: Date.now(),
  lastActiveAt: Date.now(),
  uptimeSeconds: 0
};

function connectLocalIpc() {
  if (localIpcSocket && (localIpcSocket.readyState === WebSocket.OPEN || localIpcSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (localIpcConnecting) {
    return;
  }

  localIpcConnecting = true;
  try {
    const ws = new WebSocket(LOCAL_IPC_URL);
    localIpcSocket = ws;

    ws.addEventListener('open', () => {
      localIpcReady = true;
      localIpcConnecting = false;
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event?.data || '{}'));
        if (msg?.type !== 'target_cleanup' || !msg?.mint) {
          return;
        }

        releaseTrackedTarget(msg.mint).catch(() => { });
      } catch { }
    });

    ws.addEventListener('close', () => {
      localIpcReady = false;
      localIpcConnecting = false;
    });

    ws.addEventListener('error', () => {
      localIpcReady = false;
      localIpcConnecting = false;
    });
  } catch {
    localIpcReady = false;
    localIpcConnecting = false;
  }
}

async function releaseTrackedTarget(mint) {
  if (!mint) {
    return;
  }

  const stored = await chrome.storage.local.get([KEYS.trackedTargets]);
  const trackedTargets = { ...(stored[KEYS.trackedTargets] || {}) };
  if (!Object.prototype.hasOwnProperty.call(trackedTargets, mint)) {
    return;
  }

  delete trackedTargets[mint];
  await chrome.storage.local.set({ [KEYS.trackedTargets]: trackedTargets });
}

function sendIpcTokenMetadata(token, sender) {
  if (!token || !localIpcSocket || !localIpcReady || localIpcSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  const payload = {
    type: 'token_metadata',
    authToken: LOCAL_IPC_AUTH_TOKEN,
    payload: {
      mint: token.contractAddress || token.tokenId || '',
      tokenId: token.tokenId || '',
      ticker: token.ticker || '',
      name: token.name || '',
      platform: token.platform || '',
      sourceHost: sender?.url ? new URL(sender.url).host : '',
      age: token.age || '',
      marketCap: token.marketCap || '',
      volume: token.volume || '',
      liquidity: token.liquidity || '',
      netFlow: token.netFlow || '',
      funding: token.funding || '',
      txTotal: token.txTotal || '',
      txBuys: token.txBuys || '',
      txSells: token.txSells || '',
      buyRatio: token.buyRatio || '',
      top10Pct: token.topHolders || token.top10Pct || '',
      bundlersPct: token.bundlePct || token.bundlersPct || '',
      devPct: token.insiderPct || token.devPct || '',
      ratPct: token.ratPct || '',
      sniperPct: token.sniperPct || '',
      bluechipPct: token.bluechipPct || '',
      devSoldAge: token.devSoldAge || '',
      smartMoney: token.smartMoney || '',
      smartDegen: token.smartDegen || '',
      holders: token.holders || '',
      watchers: token.watchers || '',
      socialLink: token.socialLink || '',
      twitterHandle: token.twitterHandle || '',
      twitterFollowers: token.twitterFollowers || '',
      websiteLink: token.websiteLink || '',
      lpBurned: token.lpBurned ?? true,
      updatedAt: Date.now()
    }
  };

  try {
    localIpcSocket.send(JSON.stringify(payload));
  } catch { }
}

function sendIpcTargetAcquired({ mint, mode, amountUsd, token, snipe }) {
  if (!mint || !localIpcSocket || !localIpcReady || localIpcSocket.readyState !== WebSocket.OPEN) {
    return false;
  }

  const payload = {
    type: 'target_acquired',
    authToken: LOCAL_IPC_AUTH_TOKEN,
    mode: mode === 'live' ? 'live' : 'paper',
    mint,
    amountUsd: Number(amountUsd) > 0 ? Number(amountUsd) : 100,
    payload: {
      mint,
      ticker: token?.ticker || '',
      name: token?.name || '',
      platform: token?.platform || '',
      age: token?.age || '',
      marketCap: token?.marketCap || '',
      volume: token?.volume || '',
      liquidity: token?.liquidity || '',
      netFlow: token?.netFlow || '',
      top10Pct: token?.top10Pct || token?.topHolders || '',
      bundlersPct: token?.bundlersPct || token?.bundlePct || '',
      devPct: token?.devPct || token?.insiderPct || '',
      ratPct: token?.ratPct || '',
      bluechipPct: token?.bluechipPct || '',
      smartMoney: token?.smartMoney || '',
      holders: token?.holders || '',
      socialLink: token?.socialLink || '',
      twitterHandle: token?.twitterHandle || '',
      twitterFollowers: token?.twitterFollowers || '',
      lpBurned: token?.lpBurned ?? null,
      snipe
    }
  };

  try {
    localIpcSocket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

// Ring buffer for filter decisions (kept in memory, saved to storage periodically)
const filterDecisionBuffer = [];
const MAX_FILTER_DECISIONS = 100;

function sendIpcFilterDecision(decision, sender) {
  // Store locally for popup access
  filterDecisionBuffer.push(decision);
  if (filterDecisionBuffer.length > MAX_FILTER_DECISIONS) {
    filterDecisionBuffer.shift();
  }

  // Periodically flush to chrome.storage (every 10 decisions to avoid thrashing)
  if (filterDecisionBuffer.length % 10 === 0) {
    chrome.storage.local.set({ [KEYS.filterDecisions]: filterDecisionBuffer.slice(-50) });
  }

  // Send over WebSocket to monitor.js
  if (!localIpcSocket || !localIpcReady || localIpcSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  const payload = {
    type: 'filter_decision',
    authToken: LOCAL_IPC_AUTH_TOKEN,
    payload: {
      token_ca: decision.token_ca,
      ticker: decision.ticker,
      plan_used: decision.plan_used,
      passes_rules: decision.passes_rules,
      score: decision.score_0_to_100,
      action: decision.recommended_action,
      critical_fails: decision.critical_fails,
      risk_flags: decision.risk_flags,
      reasoning: decision.reasoning,
      raw_token: decision.raw_token,
      individual_checks: decision.individual_checks,
      sourceHost: sender?.url ? new URL(sender.url).host : '',
      timestamp: decision.timestamp
    }
  };

  try {
    localIpcSocket.send(JSON.stringify(payload));
  } catch { }
}

function pushMetadataBatchToLocalIpc(tokens, sender) {
  if (!Array.isArray(tokens) || !tokens.length) {
    return;
  }

  connectLocalIpc();
  if (!localIpcSocket || !localIpcReady || localIpcSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  for (const token of tokens) {
    sendIpcTokenMetadata(token, sender);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.values(KEYS));
  await chrome.storage.local.set({
    [KEYS.settings]: current[KEYS.settings] || DEFAULT_SETTINGS,
    [KEYS.hud]: current[KEYS.hud] || DEFAULT_HUD,
    [KEYS.watchlist]: current[KEYS.watchlist] || {},
    [KEYS.positions]: current[KEYS.positions] || {},
    [KEYS.marketFeed]: current[KEYS.marketFeed] || {},
    [KEYS.logs]: current[KEYS.logs] || [],
    [KEYS.trackedTabs]: current[KEYS.trackedTabs] || {},
    [KEYS.trackedTargets]: current[KEYS.trackedTargets] || {}
  });
  ensureScanAlarm(true);
  await adoptExistingPlatformTabs();
  await appendLog('MemeScanner Pro initialized (MV3).');
});

chrome.runtime.onStartup.addListener(async () => {
  const { settings } = await getState();
  ensureScanAlarm(!!settings.enabled);
  await adoptExistingPlatformTabs();
  await kickTrackedTabs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== SCAN_ALARM) {
    return;
  }
  kickTrackedTabs();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTrackedTabById(tabId).catch(() => { });
});


chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab?.url) {
    return;
  }
  const host = toNormalizedHost(tab.url);
  if (!isSupportedHost(host)) {
    return;
  }
  registerTrackedTab(host, tabId)
    .then(() => forceScanOnTab(tabId))
    .catch(() => { });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'GET_STATE': {
          const state = await getState();
          sendResponse({ ok: true, ...state });
          return;
        }
        case 'TOGGLE_SCANNER': {
          const out = await toggleScanner();
          sendResponse({ ok: true, enabled: out.enabled });
          return;
        }
        case 'UPSERT_SETTINGS': {
          await upsertSettings(message.payload || {});
          sendResponse({ ok: true });
          return;
        }
        case 'MARKET_BATCH': {
          await processMarketBatch(message.payload || {}, sender);
          sendResponse({ ok: true });
          return;
        }
        case 'CONTENT_STATUS': {
          await processContentStatus(message.payload || {}, sender);
          sendResponse({ ok: true });
          return;
        }
        case 'TOGGLE_WATCH': {
          await toggleWatch(message.token);
          sendResponse({ ok: true });
          return;
        }
        case 'SIM_BUY': {
          await buySimulation(message.token, message.amountUsd);
          sendResponse({ ok: true });
          return;
        }
        case 'SIM_SELL': {
          await sellSimulation(message.tokenId);
          sendResponse({ ok: true });
          return;
        }
        case 'CLEAR_LIST': {
          await clearList(message.target);
          sendResponse({ ok: true });
          return;
        }
        case 'OPEN_PLATFORM': {
          const out = await openOrReusePlatformTab(message.url || '');
          sendResponse({ ok: true, ...out });
          return;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type.' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();
  return true;
});

async function getState() {
  const data = await chrome.storage.local.get(Object.values(KEYS));
  const storedSettings = data[KEYS.settings] || {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    filters: {
      ...DEFAULT_SETTINGS.filters,
      ...(storedSettings.filters || {}),
      protocols: {
        ...DEFAULT_SETTINGS.filters.protocols,
        ...(storedSettings.filters?.protocols || {})
      }
    }
  };
  const hud = await computeUptime(data[KEYS.hud] || DEFAULT_HUD, settings.enabled);
  const watchlist = data[KEYS.watchlist] || {};
  const positions = data[KEYS.positions] || {};
  const marketFeed = data[KEYS.marketFeed] || {};
  const logs = data[KEYS.logs] || [];
  const trackedTargets = data[KEYS.trackedTargets] || {};

  return {
    settings,
    hud,
    watchlist,
    positions,
    marketFeed,
    logs,
    trackedTargets
  };
}

async function toggleScanner() {
  const { settings, hud } = await getState();
  const nextSettings = {
    ...settings,
    enabled: !settings.enabled
  };
  const nextHud = {
    ...hud,
    lastActiveAt: Date.now()
  };
  await chrome.storage.local.set({ [KEYS.settings]: nextSettings, [KEYS.hud]: nextHud });
  ensureScanAlarm(!!nextSettings.enabled);
  await appendLog(nextSettings.enabled ? 'Scanner enabled.' : 'Scanner paused.');
  return nextSettings;
}

async function upsertSettings(patch) {
  const { settings } = await getState();
  const merged = {
    ...settings,
    ...patch,
    filters: {
      ...(settings.filters || {}),
      ...(patch.filters || {})
    },
    snipeFilters: {
      ...(settings.snipeFilters || {}),
      ...(patch.snipeFilters || {})
    }
  };
  await chrome.storage.local.set({ [KEYS.settings]: merged });
  if (Object.prototype.hasOwnProperty.call(patch, 'liveItemsTarget')) {
    await applyLiveItemsZoomToAllPlatformTabs(Number(merged.liveItemsTarget || 10));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'refreshMs') || Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
    ensureScanAlarm(!!merged.enabled);
  }
  await appendLog('Settings updated.');
}

async function processMarketBatch(payload, sender) {
  const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
  const removedTokenIds = Array.isArray(payload.removedTokenIds) ? payload.removedTokenIds : [];
  if (!tokens.length && !removedTokenIds.length) {
    return;
  }

  const state = await getState();
  if (!state.settings.enabled) {
    return;
  }

  connectLocalIpc();

  const hostFromSender = toNormalizedHost(sender?.url || '');
  if (hostFromSender && sender?.tab?.id) {
    await registerTrackedTab(hostFromSender, sender.tab.id);
  }

  const feed = { ...state.marketFeed };
  const watchlist = { ...state.watchlist };
  const positions = { ...state.positions };
  const trackedTargets = { ...(state.trackedTargets || {}) };
  const scannedNow = new Set();
  let matchedCount = 0;
  let rejectedCount = 0;
  const now = Date.now();

  for (const [mint, ts] of Object.entries(trackedTargets)) {
    if (!Number.isFinite(Number(ts)) || now - Number(ts) > TRACKED_TARGET_TTL_MS) {
      delete trackedTargets[mint];
    }
  }

  for (const removedId of removedTokenIds) {
    if (!removedId) {
      continue;
    }
    delete feed[removedId];
    if (watchlist[removedId]) {
      delete watchlist[removedId];
    }
  }

  for (const token of tokens) {
    const tokenId = getTokenId(token);
    if (!tokenId) {
      continue;
    }

    scannedNow.add(tokenId);
    const tokenRecord = {
      ...token,
      tokenId,
      updatedAt: Date.now(),
      pageOrder: Number.isFinite(Number(token.pageOrder)) ? Number(token.pageOrder) : Number.MAX_SAFE_INTEGER,
      sourceHost: sender?.url ? new URL(sender.url).host : ''
    };

    // ── Advanced Filter Engine evaluation ──
    const filterPlan = state.settings.filterPlan || 'balanced';
    const decision = MemeUtils.evaluateToken(tokenRecord, filterPlan);
    tokenRecord.filterDecision = decision;
    tokenRecord.matchesFilters = decision.passes_rules;
    tokenRecord.filterReasons = decision.risk_flags;
    tokenRecord.filterScore = decision.score_0_to_100;
    tokenRecord.filterAction = decision.recommended_action;

    // Send decision to IPC (monitor.js) for logging
    sendIpcFilterDecision(decision, sender);

    const includeInFeed = true;

    if (decision.passes_rules) {
      matchedCount += 1;
    } else {
      rejectedCount += 1;
    }

    if (includeInFeed) {
      feed[tokenId] = tokenRecord;
    }

    if (watchlist[tokenId]) {
      watchlist[tokenId] = {
        ...watchlist[tokenId],
        ...tokenRecord,
        updatedAt: Date.now()
      };
    }

    if (positions[tokenId]) {
      positions[tokenId] = recalcPosition(positions[tokenId], tokenRecord);
    }

    const mint = tokenRecord.contractAddress || tokenRecord.tokenId || '';
    const snipe = passesSnipeFilters(tokenRecord, state.settings.snipeFilters || {});
    if (mint && snipe.passed && !trackedTargets[mint]) {
      const sent = sendIpcTargetAcquired({
        mint,
        mode: state.settings.executionMode || 'paper',
        amountUsd: state.settings.snipeFilters?.amountUsd || 100,
        token: tokenRecord,
        snipe: {
          ageSeconds: snipe.ageSeconds,
          velocity: snipe.velocity,
          top10Pct: snipe.top10Pct
        }
      });
      if (sent) {
        trackedTargets[mint] = now;
      }
    }
  }

  pushMetadataBatchToLocalIpc(tokens, sender);

  const trimmedFeed = trimFeed(feed, MAX_FEED_ITEMS);
  const nextHud = await computeUptime(
    {
      ...state.hud,
      totalScanned: (state.hud.totalScanned || 0) + scannedNow.size,
      totalMatched: (state.hud.totalMatched || 0) + matchedCount,
      totalRejected: (state.hud.totalRejected || 0) + rejectedCount,
      feedCount: Object.keys(trimmedFeed).length,
      watchCount: Object.keys(watchlist).length,
      openPositions: Object.keys(positions).length,
      lastActiveAt: Date.now()
    },
    true
  );

  await chrome.storage.local.set({
    [KEYS.marketFeed]: trimmedFeed,
    [KEYS.watchlist]: watchlist,
    [KEYS.positions]: positions,
    [KEYS.hud]: nextHud,
    [KEYS.trackedTargets]: trackedTargets
  });
}

async function processContentStatus(payload, sender) {
  const host = sender?.url ? new URL(sender.url).host : 'unknown-host';
  const message = String(payload?.message || '').trim();
  if (!message) {
    return;
  }
  await appendLog(`[content:${host}] ${message}`);
}

function recalcPosition(position, token) {
  const currentMarketCap = MemeUtils.parseValue(token.marketCap || '0');
  if (!currentMarketCap || !position.entryMarketCap) {
    return position;
  }
  const multiplier = currentMarketCap / position.entryMarketCap;
  const currentUsd = position.entryUsd * multiplier;
  const pnlUsd = currentUsd - position.entryUsd;
  const pnlPct = position.entryUsd > 0 ? (pnlUsd / position.entryUsd) * 100 : 0;
  return {
    ...position,
    currentMarketCap,
    currentUsd,
    pnlUsd,
    pnlPct,
    updatedAt: Date.now()
  };
}

async function toggleWatch(token) {
  const tokenId = getTokenId(token || {});
  if (!tokenId) {
    return;
  }
  const { watchlist, hud } = await getState();
  const nextWatch = { ...watchlist };
  if (nextWatch[tokenId]) {
    delete nextWatch[tokenId];
    await appendLog(`Watch removed: ${token?.ticker || tokenId}`);
  } else {
    nextWatch[tokenId] = {
      ...(token || {}),
      tokenId,
      addedAt: Date.now(),
      updatedAt: Date.now()
    };
    await appendLog(`Watch added: ${token?.ticker || tokenId}`);
  }

  await chrome.storage.local.set({
    [KEYS.watchlist]: nextWatch,
    [KEYS.hud]: {
      ...hud,
      watchCount: Object.keys(nextWatch).length,
      lastActiveAt: Date.now()
    }
  });
}

async function buySimulation(token, amountUsd) {
  const tokenId = getTokenId(token || {});
  if (!tokenId) {
    return;
  }

  const { positions, settings, hud } = await getState();
  const nextPositions = { ...positions };
  const entryUsd = Number(amountUsd) > 0 ? Number(amountUsd) : Number(settings.defaultPositionUsd || 100);
  const entryMarketCap = MemeUtils.parseValue(token.marketCap || '0');
  if (!entryMarketCap) {
    return;
  }

  nextPositions[tokenId] = {
    tokenId,
    ticker: token.ticker || 'UNKNOWN',
    name: token.name || '',
    entryUsd,
    entryMarketCap,
    currentMarketCap: entryMarketCap,
    currentUsd: entryUsd,
    pnlUsd: 0,
    pnlPct: 0,
    boughtAt: Date.now(),
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({
    [KEYS.positions]: nextPositions,
    [KEYS.hud]: {
      ...hud,
      openPositions: Object.keys(nextPositions).length,
      lastActiveAt: Date.now()
    }
  });

  await appendLog(`Sim buy: ${nextPositions[tokenId].ticker} @ $${entryUsd.toFixed(2)}`);
}

async function sellSimulation(tokenId) {
  if (!tokenId) {
    return;
  }
  const { positions, hud } = await getState();
  if (!positions[tokenId]) {
    return;
  }

  const sold = positions[tokenId];
  const nextPositions = { ...positions };
  delete nextPositions[tokenId];

  await chrome.storage.local.set({
    [KEYS.positions]: nextPositions,
    [KEYS.hud]: {
      ...hud,
      openPositions: Object.keys(nextPositions).length,
      lastActiveAt: Date.now()
    }
  });
  await appendLog(`Sim sell: ${sold.ticker}`);
}

async function clearList(target) {
  const { hud } = await getState();
  if (target === 'feed') {
    const now = Date.now();
    await chrome.storage.local.set({
      [KEYS.marketFeed]: {},
      [KEYS.watchlist]: {},
      [KEYS.positions]: {},
      [KEYS.hud]: {
        ...hud,
        totalScanned: 0,
        totalMatched: 0,
        totalRejected: 0,
        feedCount: 0,
        watchCount: 0,
        openPositions: 0,
        startedAt: now,
        lastActiveAt: now,
        uptimeSeconds: 0
      }
    });
    await appendLog('Dashboard reset from Feed clear.');
    return;
  }
  if (target === 'watchlist') {
    await chrome.storage.local.set({ [KEYS.watchlist]: {}, [KEYS.hud]: { ...hud, watchCount: 0 } });
    return;
  }
  if (target === 'positions') {
    await chrome.storage.local.set({
      [KEYS.positions]: {},
      [KEYS.hud]: { ...hud, openPositions: 0 }
    });
    return;
  }
  if (target === 'logs') {
    await chrome.storage.local.set({ [KEYS.logs]: [] });
  }
}

async function computeUptime(hud, enabled) {
  const now = Date.now();
  const previous = Number(hud.lastActiveAt || now);
  const deltaSeconds = Math.max(0, Math.floor((now - previous) / 1000));
  return {
    ...hud,
    lastActiveAt: now,
    uptimeSeconds: enabled ? (hud.uptimeSeconds || 0) + deltaSeconds : hud.uptimeSeconds || 0
  };
}

function getTokenId(token) {
  return token?.contractAddress || token?.tokenId || token?.tokenPath || token?.ticker || '';
}

function trimFeed(feedMap, maxSize) {
  const entries = Object.entries(feedMap);
  entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  return Object.fromEntries(entries.slice(0, maxSize));
}

async function appendLog(message) {
  const data = await chrome.storage.local.get(KEYS.logs);
  const logs = Array.isArray(data[KEYS.logs]) ? data[KEYS.logs] : [];
  const next = [
    {
      at: Date.now(),
      message
    },
    ...logs
  ].slice(0, MAX_LOGS);
  await chrome.storage.local.set({ [KEYS.logs]: next });
}

async function openOrReusePlatformTab(targetUrl) {
  if (!targetUrl) {
    throw new Error('Missing platform url.');
  }

  const { settings } = await getState();
  const host = new URL(targetUrl).hostname;

  if (openPlatformLocks.has(host)) {
    const lockData = openPlatformLocks.get(host);
    if (lockData && Date.now() - Number(lockData.timestamp || 0) <= PLATFORM_LOCK_STALE_MS) {
      return lockData.promise;
    }
    openPlatformLocks.delete(host);
  }

  const run = (async () => {
    const pattern = getPlatformPattern(host);
    const existing = await chrome.tabs.query({ url: pattern });

    let validTab = null;
    for (const candidate of existing) {
      if (!candidate?.id) {
        continue;
      }
      try {
        const aliveTab = await chrome.tabs.get(candidate.id);
        if (!aliveTab?.id) {
          await removeTrackedTabById(candidate.id);
          continue;
        }
        validTab = aliveTab;
        break;
      } catch {
        await removeTrackedTabById(candidate.id);
      }
    }

    let tab;
    if (validTab?.id) {
      tab = await chrome.tabs.update(validTab.id, {
        url: targetUrl,
        pinned: !!settings.launchPinned,
        autoDiscardable: false,
        active: settings.launchInBackground ? false : true
      });
      if (!settings.launchInBackground && tab?.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await appendLog(`Reused tracked tab for ${host}.`);
    } else {
      tab = await chrome.tabs.create({
        url: targetUrl,
        pinned: !!settings.launchPinned,
        autoDiscardable: false,
        active: settings.launchInBackground ? false : true
      });
      await appendLog(`Opened tracked tab for ${host}.`);
    }

    if (!tab?.id) {
      throw new Error(`Failed to open platform tab for ${host}.`);
    }

    await chrome.tabs.update(tab.id, { autoDiscardable: false });
    await registerTrackedTab(host, tab.id);

    await applyLiveItemsZoomToTab(tab.id, Number(settings.liveItemsTarget || 10));
    setTimeout(() => {
      forceScanOnTab(tab.id);
    }, 700);

    return { tabId: tab.id, reused: !!validTab?.id };
  })();

  openPlatformLocks.set(host, {
    promise: run,
    timestamp: Date.now()
  });
  try {
    return await run;
  } finally {
    openPlatformLocks.delete(host);
  }
}

function getPlatformPattern(hostname) {
  const host = String(hostname || '').replace(/^www\./, '');
  return [`*://${host}/*`, `*://www.${host}/*`];
}

function getZoomFactor(liveItemsTarget) {
  const map = {
    10: 1,
    14: 0.9,
    18: 0.8,
    22: 0.75,
    26: 0.67,
    30: 0.5,
    33: 0.33
  };
  const target = Number(liveItemsTarget || 10);
  if (map[target]) {
    return map[target];
  }
  if (target <= 10) {
    return 1;
  }
  return Math.max(0.33, 1 - (target - 10) * 0.025);
}

async function applyLiveItemsZoomToAllPlatformTabs(liveItemsTarget) {
  const urls = ['*://axiom.trade/*', '*://www.axiom.trade/*', '*://gmgn.ai/*', '*://www.gmgn.ai/*', '*://pump.fun/*', '*://www.pump.fun/*'];
  const tabs = await chrome.tabs.query({ url: urls });
  await Promise.all(tabs.map((tab) => applyLiveItemsZoomToTab(tab.id, liveItemsTarget)));
}

async function applyLiveItemsZoomToTab(tabId, liveItemsTarget) {
  if (!tabId) {
    return;
  }
  const zoomFactor = getZoomFactor(liveItemsTarget);
  try {
    await chrome.tabs.setZoom(tabId, zoomFactor);
  } catch (error) {
    await appendLog(`Zoom apply failed on tab ${tabId}: ${error?.message || String(error)}`);
  }
}

function forceScanOnTab(tabId) {
  if (!tabId) {
    return;
  }
  chrome.tabs.sendMessage(tabId, { type: 'FORCE_SCAN' }, () => {
    if (chrome.runtime.lastError) {
      return;
    }
  });
}

function ensureScanAlarm(enabled) {
  if (!enabled) {
    chrome.alarms.clear(SCAN_ALARM, () => { });
    return;
  }

  chrome.alarms.create(SCAN_ALARM, {
    delayInMinutes: 0.5,
    periodInMinutes: 0.5
  });
}

function toNormalizedHost(urlOrHost) {
  if (!urlOrHost) {
    return '';
  }
  try {
    const host = urlOrHost.includes('://') ? new URL(urlOrHost).hostname : String(urlOrHost);
    return host.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isSupportedHost(host) {
  return ['axiom.trade', 'gmgn.ai', 'pump.fun'].some((base) => host === base || host.endsWith(`.${base}`));
}

async function registerTrackedTab(hostname, tabId) {
  if (!hostname || !tabId) {
    return;
  }
  const host = toNormalizedHost(hostname);
  if (!isSupportedHost(host)) {
    return;
  }
  const data = await chrome.storage.local.get(KEYS.trackedTabs);
  const trackedTabs = { ...(data[KEYS.trackedTabs] || {}) };
  trackedTabs[host] = tabId;
  await chrome.storage.local.set({ [KEYS.trackedTabs]: trackedTabs });
}

async function removeTrackedTabById(tabId) {
  if (!tabId) {
    return;
  }
  const data = await chrome.storage.local.get(KEYS.trackedTabs);
  const trackedTabs = { ...(data[KEYS.trackedTabs] || {}) };
  let changed = false;
  for (const [host, id] of Object.entries(trackedTabs)) {
    if (id === tabId) {
      delete trackedTabs[host];
      openPlatformLocks.delete(host);
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [KEYS.trackedTabs]: trackedTabs });
  }
}

async function adoptExistingPlatformTabs() {
  const urls = ['*://axiom.trade/*', '*://www.axiom.trade/*', '*://gmgn.ai/*', '*://www.gmgn.ai/*', '*://pump.fun/*', '*://www.pump.fun/*'];
  const tabs = await chrome.tabs.query({ url: urls });
  for (const tab of tabs) {
    if (!tab?.id || !tab?.url) {
      continue;
    }
    const host = toNormalizedHost(tab.url);
    await registerTrackedTab(host, tab.id);
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch {
      // ignore update failures
    }
  }
}

async function kickTrackedTabs() {
  const { settings } = await getState();
  if (!settings.enabled) {
    return;
  }

  const data = await chrome.storage.local.get(KEYS.trackedTabs);
  const trackedTabs = { ...(data[KEYS.trackedTabs] || {}) };

  for (const [host, tabId] of Object.entries(trackedTabs)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.id) {
        delete trackedTabs[host];
        continue;
      }

      if (tab.discarded) {
        await chrome.tabs.reload(tab.id);
      }

      await chrome.tabs.update(tab.id, { autoDiscardable: false });
      await applyLiveItemsZoomToTab(tab.id, Number(settings.liveItemsTarget || 10));
      forceScanOnTab(tab.id);
    } catch {
      delete trackedTabs[host];
    }
  }

  await chrome.storage.local.set({ [KEYS.trackedTabs]: trackedTabs });
}
