/**
 * MemeScanner — Background Service Worker (The Brain)
 * 
 * Central coordinator:
 * - Receives token data from Primary Observer (content-router.js on main feed)
 * - Deduplicates tokens
 * - Runs filter engine against user-configured criteria
 * - Opens matching tokens in new background tabs
 * - Receives secondary data from token detail page observers
 * - Manages tab lifecycle and cleanup
 * - Provides state to the Popup UI
 */

importScripts('utils.js');

// ═══════════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════════

const state = {
  // All tokens ever seen: tokenPath → tokenData
  seenTokens: new Map(),

  // Tokens that passed filters: tokenPath → { token, tabId, status, detailData }
  watchedTokens: new Map(),

  // Tokens rejected by filters (kept for stats): tokenPath → { token, reasons }
  rejectedTokens: new Map(),

  // Activity log (circular buffer, max 200 entries)
  logs: [],

  // Stats
  stats: {
    totalScanned: 0,
    totalMatched: 0,
    totalRejected: 0,
    startedAt: Date.now()
  },

  // Filter config (loaded from storage on init)
  filters: {
    maxAge: 0,          // 0 = disabled (shows all ages)
    minVolume: 0,       // Minimum volume in USD (0 = disabled)
    minMC: 0,           // Minimum market cap in USD (0 = disabled)
    minTX: 0,           // Minimum transaction count (0 = disabled)
    autoOpen: false,    // Don't auto-open until user enables it
    maxTabs: 5,         // Max simultaneous monitored tabs
    enabled: true       // Master on/off switch
  }
};

const MAX_LOGS = 200;

// ═══════════════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

async function init() {
  log('🚀 MemeScanner background worker started');

  // Load saved filters
  try {
    const stored = await chrome.storage.local.get(['filters', 'stats']);
    if (stored.filters) {
      Object.assign(state.filters, stored.filters);
      log('📋 Loaded saved filters');
    }
    if (stored.stats) {
      state.stats.totalScanned = stored.stats.totalScanned || 0;
      state.stats.totalMatched = stored.stats.totalMatched || 0;
      state.stats.totalRejected = stored.stats.totalRejected || 0;
    }
  } catch (err) {
    log('⚠️ Could not load saved filters, using defaults');
  }
}

init();

// ═══════════════════════════════════════════════════════════════════
//  MESSAGE HANDLERS
// ═══════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'NEW_TOKENS':
      handleNewTokens(message.tokens);
      break;

    case 'SECONDARY_DATA':
      handleSecondaryData(message.tokenPath, message.data);
      break;

    case 'SECONDARY_TAB_READY':
      handleSecondaryTabReady(message.tokenPath, sender.tab?.id);
      break;

    case 'GET_STATE':
      sendResponse(getPublicState());
      return true; // Keep channel open for async response

    case 'UPDATE_FILTERS':
      updateFilters(message.filters);
      sendResponse({ success: true });
      return true;

    case 'TOGGLE_ENABLED':
      state.filters.enabled = !state.filters.enabled;
      saveFilters();
      log(state.filters.enabled ? '▶️ Scanner enabled' : '⏸️ Scanner paused');
      sendResponse({ enabled: state.filters.enabled });
      return true;

    case 'CLOSE_WATCHED':
      closeWatchedToken(message.tokenPath);
      sendResponse({ success: true });
      return true;

    case 'GET_LOGS':
      sendResponse({ logs: state.logs.slice(-50) });
      return true;

    default:
      break;
  }
});

// ═══════════════════════════════════════════════════════════════════
//  CORE LOGIC
// ═══════════════════════════════════════════════════════════════════

function handleNewTokens(tokens) {
  if (!state.filters.enabled) return;

  let newCount = 0;
  let updateCount = 0;
  let matchCount = 0;

  tokens.forEach(token => {
    const key = token.contractAddress || token.ticker || MemeUtils.tokenKey(token);
    if (!key) return;

    const isUpdate = token._updateType === 'UPDATED';
    delete token._updateType;

    if (isUpdate) {
      updateCount++;
      state.seenTokens.set(key, token);
    } else {
      if (state.seenTokens.has(key)) return;
      newCount++;
      state.seenTokens.set(key, token);
      state.stats.totalScanned++;
    }

    // Build audit summary
    const auditFlags = [];
    if (token.topHoldersRisk) auditFlags.push(`Top:${token.topHolders}`);
    if (token.insiderRisk) auditFlags.push(`Ins:${token.insiderPct}`);
    if (token.sniperRisk) auditFlags.push(`Snp:${token.sniperPct}`);
    if (token.botRisk) auditFlags.push(`Bot:${token.botPct}`);
    if (token.bundleRisk) auditFlags.push(`Bnd:${token.bundlePct}`);
    if (token.dexPaidRisk) auditFlags.push('DEX:Unpaid');
    const auditStr = auditFlags.length > 0 ? ` | ⚠️ ${auditFlags.join(', ')}` : ' | ✅ Clean';

    // Log every token with all data
    log(`🪙 ${token.ticker || '???'} (${token.name || '—'}) | Age: ${token.age || '?'} | MC: ${token.marketCap || '?'} ${token.mcChange || ''} | Liq: ${token.liquidity || '?'} | Vol: ${token.volume || '?'} | TX: ${token.txTotal || '?'} (${token.txBuys || '?'}/${token.txSells || '?'}) | 👥${token.holders || '?'} 🎯${token.proTraders || '?'}${auditStr}`);

    // Run filter engine
    const hasActiveFilters = state.filters.maxAge > 0 || state.filters.minVolume > 0 || state.filters.minMC > 0 || state.filters.minTX > 0;
    const result = hasActiveFilters ? MemeUtils.matchesFilters(token, state.filters) : { passed: true, reasons: [] };

    if (result.passed) {
      matchCount++;
      if (!isUpdate) state.stats.totalMatched++;

      if (state.filters.autoOpen && !state.watchedTokens.has(key) && state.watchedTokens.size < state.filters.maxTabs) {
        openTokenTab(token);
      } else if (state.filters.autoOpen && state.watchedTokens.size >= state.filters.maxTabs && !state.watchedTokens.has(key)) {
        log(`⚠️ Tab limit (${state.filters.maxTabs}). ${token.ticker} queued.`);
        state.watchedTokens.set(key, { token, tabId: null, status: 'queued', detailData: null });
      }
    } else {
      if (!isUpdate) {
        state.stats.totalRejected++;
        state.rejectedTokens.set(key, { token, reasons: result.reasons });
        log(`❌ REJECTED: ${token.ticker || '???'} — ${result.reasons.join(', ')}`);
      }
    }
  });

  if (newCount > 0 || updateCount > 0) {
    log(`📥 ${newCount} new, ${updateCount} updated, ${matchCount} matched`);
    saveStats();
  }
}

async function openTokenTab(token) {
  const key = token.contractAddress || token.ticker || MemeUtils.tokenKey(token);
  const url = token.tokenPath
    ? (token.tokenPath.startsWith('http') ? token.tokenPath : `https://axiom.trade${token.tokenPath}`)
    : (token.contractAddress ? `https://axiom.trade/t/${token.contractAddress}/sol` : null);

  if (!url) {
    log(`⚠️ No URL for ${token.ticker}, skipping tab open`);
    return;
  }

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    state.watchedTokens.set(key, {
      token,
      tabId: tab.id,
      status: 'monitoring',
      detailData: null,
      openedAt: Date.now()
    });
    log(`🔵 Opened tab for ${token.ticker || token.name}: ${url}`);
  } catch (err) {
    log(`❌ Failed to open tab for ${token.ticker}: ${err.message}`);
  }
}

function handleSecondaryData(tokenPath, data) {
  // Find the watched token by path
  for (const [key, entry] of state.watchedTokens) {
    if (entry.token.tokenPath === tokenPath) {
      entry.detailData = data;
      entry.lastUpdate = Date.now();

      // Check for rug indicators
      if (data.isRugRisk && data.rugIndicators.length > 0) {
        log(`🚨 RUG RISK for ${entry.token.ticker}: ${data.rugIndicators.join(', ')}`);
        // Notify via Chrome notification
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '🚨 MemeScanner — Rug Risk Detected',
          message: `${entry.token.ticker}: ${data.rugIndicators.join(', ')}`,
          priority: 2
        }).catch(() => {});
      }
      return;
    }
  }
}

function handleSecondaryTabReady(tokenPath, tabId) {
  for (const [key, entry] of state.watchedTokens) {
    if (entry.token.tokenPath === tokenPath) {
      entry.tabId = tabId;
      entry.status = 'monitoring';
      log(`🔵 Secondary observer active for ${entry.token.ticker} (tab ${tabId})`);
      return;
    }
  }
}

function closeWatchedToken(tokenPath) {
  for (const [key, entry] of state.watchedTokens) {
    if (entry.token.tokenPath === tokenPath || key === tokenPath) {
      if (entry.tabId) {
        chrome.tabs.remove(entry.tabId).catch(() => {});
      }
      state.watchedTokens.delete(key);
      log(`🔴 Stopped monitoring ${entry.token.ticker || key}`);

      // Check if there are queued tokens to open
      checkQueue();
      return;
    }
  }
}

function checkQueue() {
  for (const [key, entry] of state.watchedTokens) {
    if (entry.status === 'queued' && state.watchedTokens.size < state.filters.maxTabs) {
      openTokenTab(entry.token);
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  TAB LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [key, entry] of state.watchedTokens) {
    if (entry.tabId === tabId) {
      state.watchedTokens.delete(key);
      log(`🔴 Tab closed for ${entry.token.ticker || key}`);
      checkQueue();
      return;
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
//  STATE ACCESSORS
// ═══════════════════════════════════════════════════════════════════

function getPublicState() {
  return {
    enabled: state.filters.enabled,
    filters: { ...state.filters },
    stats: {
      ...state.stats,
      currentlyWatching: state.watchedTokens.size,
      totalSeen: state.seenTokens.size,
      uptimeMs: Date.now() - state.stats.startedAt
    },
    watchedTokens: Array.from(state.watchedTokens.entries()).map(([key, entry]) => ({
      key,
      ticker: entry.token.ticker,
      name: entry.token.name,
      tokenPath: entry.token.tokenPath,
      contractAddress: entry.token.contractAddress,
      age: entry.token.age,
      volume: entry.token.volume,
      marketCap: entry.token.marketCap,
      mcChange: entry.token.mcChange,
      liquidity: entry.token.liquidity,
      txTotal: entry.token.txTotal,
      txBuys: entry.token.txBuys,
      txSells: entry.token.txSells,
      topHolders: entry.token.topHolders,
      topHoldersRisk: entry.token.topHoldersRisk,
      insiderPct: entry.token.insiderPct,
      botPct: entry.token.botPct,
      bundlePct: entry.token.bundlePct,
      dexPaid: entry.token.dexPaid,
      holders: entry.token.holders,
      proTraders: entry.token.proTraders,
      status: entry.status,
      detailData: entry.detailData,
      openedAt: entry.openedAt
    })),
    recentMatches: Array.from(state.seenTokens.values())
      .filter(t => {
        const result = MemeUtils.matchesFilters(t, state.filters);
        return result.passed;
      })
      .slice(-20)
      .reverse()
  };
}

// ═══════════════════════════════════════════════════════════════════
//  PERSISTENCE
// ═══════════════════════════════════════════════════════════════════

function updateFilters(newFilters) {
  Object.assign(state.filters, newFilters);
  saveFilters();
  log('⚙️ Filters updated');
}

function saveFilters() {
  chrome.storage.local.set({ filters: state.filters }).catch(() => {});
}

function saveStats() {
  chrome.storage.local.set({
    stats: {
      totalScanned: state.stats.totalScanned,
      totalMatched: state.stats.totalMatched,
      totalRejected: state.stats.totalRejected
    }
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════════════════

function log(message) {
  const entry = {
    time: MemeUtils.formatTimestamp(),
    message
  };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) {
    state.logs = state.logs.slice(-MAX_LOGS);
  }
  console.log(`[MemeScanner] ${entry.time} ${message}`);
}
