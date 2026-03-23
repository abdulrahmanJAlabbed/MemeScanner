/**
 * MemeScanner — Content Script Router for axiom.trade
 * 
 * Precise extraction based on actual DOM structure.
 * Each div[data-index] row contains flex columns in order:
 *   1. Token info (ticker, name, age, social links, watchers)
 *   2. Chart (canvas)
 *   3. Market Cap (+ % change)
 *   4. Liquidity
 *   5. Volume
 *   6. Transactions (total + buys/sells)
 *   7. Audit badges (top holders, insider, sniper, bots, bundles, dex paid, holders, pro traders)
 *   8. Buy button
 */

(() => {
  'use strict';

  const TAG = '[MemeScanner]';
  const url = window.location.href;

  if (isDiscoverPage(url)) {
    console.log(`${TAG} 🟢 Discover page detected. Starting Primary Observer...`);
    startPrimaryObserver();
  } else if (isTokenDetailPage(url)) {
    console.log(`${TAG} 🔵 Token detail page detected. Starting Secondary Observer...`);
    startSecondaryObserver();
  } else {
    console.log(`${TAG} ⚪ Page not monitored: ${url}`);
  }

  function isDiscoverPage(url) {
    return /axiom\.trade\/discover/i.test(url);
  }

  function isTokenDetailPage(url) {
    return /axiom\.trade\/(t|meme)\//i.test(url);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  PRIMARY OBSERVER — Discover Feed
  // ═══════════════════════════════════════════════════════════════════

  function startPrimaryObserver() {
    const RETRY_INTERVAL = 2000;
    const MAX_RETRIES = 30;

    const CONTAINER_SELECTORS = [
      '#platform-layout-container > div:nth-child(3) > div > div:nth-child(2) > div > section > div > div',
      '#platform-layout-container > div:last-child > div > div:last-child > div > section > div > div',
      '#platform-layout-container section > div > div',
      '#platform-layout-container section'
    ];

    let retries = 0;
    let observer = null;
    let parentObserver = null;
    // Track all known tokens with their full data for change detection
    let knownTokens = new Map();

    function findContainer() {
      for (const selector of CONTAINER_SELECTORS) {
        try {
          const el = document.querySelector(selector);
          if (el && el.children.length > 0) {
            // Verify it contains data-index rows
            const hasDataIndex = el.querySelector('div[data-index]');
            if (hasDataIndex) {
              console.log(`${TAG} ✅ Found container via: "${selector}" (${el.children.length} rows)`);
              return el;
            }
          }
        } catch (err) { /* skip */ }
      }
      return null;
    }

    function findAndAttach() {
      const container = findContainer();
      if (!container) {
        retries++;
        if (retries > MAX_RETRIES) {
          console.error(`${TAG} ❌ Could not find container after ${MAX_RETRIES} retries.`);
          return;
        }
        console.log(`${TAG} ⏳ Container not found yet (${retries}/${MAX_RETRIES})...`);
        setTimeout(findAndAttach, RETRY_INTERVAL);
        return;
      }
      attachObserver(container);
    }

    function attachObserver(container) {
      if (observer) observer.disconnect();
      if (parentObserver) parentObserver.disconnect();

      // Shared extraction + diff logic
      function scanAndSend() {
        const tokens = extractAllTokens(container);
        if (tokens.length === 0) return;

        const updates = [];

        tokens.forEach(token => {
          const key = token.contractAddress || token.ticker;
          if (!key) return;

          const existing = knownTokens.get(key);

          if (!existing) {
            knownTokens.set(key, token);
            updates.push({ ...token, _updateType: 'NEW' });
          } else {
            const changed = hasDataChanged(existing, token);
            if (changed) {
              knownTokens.set(key, token);
              updates.push({ ...token, _updateType: 'UPDATED' });
            }
          }
        });

        if (updates.length > 0) {
          console.log(`${TAG} 📡 Sending ${updates.length} token(s) (new/updated) to background`);
          chrome.runtime.sendMessage({
            type: 'NEW_TOKENS',
            tokens: updates,
            timestamp: Date.now()
          });
        }
      }

      // MutationObserver for structural changes (new rows added/removed)
      const throttledScan = MemeUtils.throttle(scanAndSend, 1500);
      observer = new MutationObserver(throttledScan);
      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });

      // Polling interval for value changes (React reconciliation doesn't always trigger MutationObserver)
      const POLL_INTERVAL = 3000;
      const pollTimer = setInterval(() => {
        if (!document.contains(container)) {
          clearInterval(pollTimer);
          return;
        }
        scanAndSend();
      }, POLL_INTERVAL);
      console.log(`${TAG} ⏱️ Polling every ${POLL_INTERVAL / 1000}s for data changes`);

      // Initial extraction
      const initialTokens = extractAllTokens(container);
      if (initialTokens.length > 0) {
        initialTokens.forEach(t => {
          const key = t.contractAddress || t.ticker;
          if (key) knownTokens.set(key, t);
        });
        console.log(`${TAG} 📡 Initial batch: ${initialTokens.length} tokens`);
        console.log(`${TAG} 📋 Sample:`, JSON.stringify(initialTokens[0], null, 2));
        chrome.runtime.sendMessage({
          type: 'NEW_TOKENS',
          tokens: initialTokens.map(t => ({ ...t, _updateType: 'NEW' })),
          timestamp: Date.now()
        });
      }

      // Re-attach on SPA navigation (container removed from DOM)
      parentObserver = new MutationObserver(() => {
        if (!document.contains(container)) {
          console.log(`${TAG} ⚠️ Container removed. Re-scanning...`);
          observer.disconnect();
          parentObserver.disconnect();
          clearInterval(pollTimer);
          retries = 0;
          knownTokens.clear();
          setTimeout(findAndAttach, 1000);
        }
      });
      parentObserver.observe(document.body, { childList: true, subtree: true });

      console.log(`${TAG} 👁️ Observer + Poller attached. Monitoring for new/updated tokens...`);
    }

    function hasDataChanged(old, updated) {
      return old.marketCap !== updated.marketCap ||
        old.mcChange !== updated.mcChange ||
        old.volume !== updated.volume ||
        old.liquidity !== updated.liquidity ||
        old.txTotal !== updated.txTotal ||
        old.age !== updated.age ||
        old.holders !== updated.holders;
    }

    // ───────────────────────────────────────────────────────────────
    //  PRECISE TOKEN EXTRACTION
    // ───────────────────────────────────────────────────────────────

    function extractAllTokens(container) {
      const rows = container.querySelectorAll('div[data-index]');
      const tokens = [];
      rows.forEach(row => {
        try {
          const token = extractRow(row);
          if (token && (token.contractAddress || token.ticker)) {
            tokens.push(token);
          }
        } catch (err) {
          console.warn(`${TAG} Row extraction error:`, err.message);
        }
      });
      return tokens;
    }

    function extractRow(row) {
      // The main content is: div[data-index] > div.relative > div.group > div (flex row)
      const flexRow = row.querySelector('.group > div');
      if (!flexRow) return null;

      // Get all flex-1 columns (the data columns after the token info section)
      const columns = flexRow.querySelectorAll(':scope > div.flex.min-w-0.flex-1');

      // ── Token Info (first wide column: w-[224px] / w-[320px]) ──
      const infoCol = flexRow.querySelector('div[class*="w-[224px]"], div[class*="w-[320px]"]');

      // Ticker: first span.text-textPrimary inside the info column
      const tickerEl = infoCol?.querySelector('span.text-textPrimary div.truncate, span[class*="text-textPrimary"] div.truncate');
      const ticker = tickerEl?.textContent?.trim() || null;

      // Name: the copy button area has the full name
      const nameEl = infoCol?.querySelector('div[role="button"] span.text-inherit div.truncate, div[role="button"] span div.truncate');
      const name = nameEl?.textContent?.trim() || null;

      // Age: span with text-primaryGreen class in the social links row
      const ageEl = infoCol?.querySelector('span.text-primaryGreen, span[class*="text-primaryGreen"]');
      const age = ageEl?.textContent?.trim() || null;

      // Contract address: extract from pump.fun link or image src
      let contractAddress = null;
      const pumpLink = infoCol?.querySelector('a[href*="pump.fun/coin/"]');
      if (pumpLink) {
        const href = pumpLink.getAttribute('href');
        const match = href.match(/pump\.fun\/coin\/([A-Za-z0-9]+)/);
        if (match) contractAddress = match[1];
      }
      // Fallback: extract from image src
      if (!contractAddress) {
        const tokenImg = infoCol?.querySelector('img[src*="axiomtrading"]');
        if (tokenImg) {
          const src = tokenImg.getAttribute('src');
          const match = src.match(/\/([A-Za-z0-9]{30,})\.(webp|png|jpg)/);
          if (match) contractAddress = match[1];
        }
      }

      // Token path for axiom
      const tokenPath = contractAddress ? `/t/${contractAddress}/sol` : null;

      // Watchers count
      const watchersEl = infoCol?.querySelector('i.ri-eye-line + span, i[class*="ri-eye-line"]');
      let watchers = null;
      if (watchersEl) {
        const nextSpan = watchersEl.closest('.inline-flex')?.querySelector('span');
        if (nextSpan) watchers = nextSpan.textContent?.trim();
      }

      // Platform (Pump vs Raydium) - check the small badge icon
      const platformImg = infoCol?.querySelector('img[alt="Raydium"], img[alt="Pump"]');
      const platform = platformImg?.getAttribute('alt') || null;

      // ── Data Columns (flex-1 divs in order) ──
      // Column order: chart, marketCap, liquidity, volume, transactions, audit, buy
      // But chart has pr-[12px] while data columns have px-[12px]

      const dataColumns = Array.from(flexRow.querySelectorAll(':scope > div[class*="px-[12px]"]'));
      // First px-12 column = MC, then Liq, then Vol, then TX, then Audit, then Buy

      // Market Cap + % change
      let marketCap = null;
      let mcChange = null;
      if (dataColumns[0]) {
        const spans = dataColumns[0].querySelectorAll('span[class*="text-textPrimary"], span[class*="text-[12px]"][class*="font-medium"][class*="text-textPrimary"]');
        if (spans[0]) marketCap = spans[0].textContent?.trim();
        const changeEl = dataColumns[0].querySelector('span[class*="font-GeistMono"]');
        if (changeEl) mcChange = changeEl.textContent?.trim();
      }

      // Liquidity
      let liquidity = null;
      if (dataColumns[1]) {
        const span = dataColumns[1].querySelector('span[class*="text-textPrimary"]');
        if (span) liquidity = span.textContent?.trim();
      }

      // Volume
      let volume = null;
      if (dataColumns[2]) {
        const span = dataColumns[2].querySelector('span[class*="text-textPrimary"]');
        if (span) volume = span.textContent?.trim();
      }

      // Transactions
      let txTotal = null, txBuys = null, txSells = null;
      if (dataColumns[3]) {
        const totalSpan = dataColumns[3].querySelector('span[class*="text-textPrimary"]');
        if (totalSpan) txTotal = totalSpan.textContent?.trim();
        const buySpan = dataColumns[3].querySelector('span[class*="text-increase"]');
        if (buySpan) txBuys = buySpan.textContent?.trim();
        const sellSpan = dataColumns[3].querySelector('span[class*="text-decrease"]');
        if (sellSpan) txSells = sellSpan.textContent?.trim();
      }

      // ── Audit Badges ──
      const audit = extractAuditBadges(dataColumns[4]);

      return {
        tokenPath,
        contractAddress,
        ticker,
        name,
        age,
        platform,
        watchers,
        marketCap,
        mcChange,
        liquidity,
        volume,
        txTotal,
        txBuys,
        txSells,
        ...audit,
        discoveredAt: Date.now()
      };
    }

    function extractAuditBadges(auditCol) {
      const result = {
        topHolders: null,    // ri-user-star-line
        topHoldersRisk: false,
        insiderPct: null,    // icon-chef-hat
        insiderRisk: false,
        sniperPct: null,     // ri-crosshair-2-line
        sniperRisk: false,
        botPct: null,        // ri-ghost-line
        botRisk: false,
        bundlePct: null,     // icon-boxes
        bundleRisk: false,
        dexPaid: null,       // icon-dex-paid → "Paid" or "Unpaid"
        dexPaidRisk: false,
        holders: null,       // ri-user-line
        proTraders: null     // icon-pro-trader
      };

      if (!auditCol) return result;

      // Each badge is a small div with an icon <i> and a <span> with the value
      const badges = auditCol.querySelectorAll('div[class*="min-h-[16px]"]');

      badges.forEach(badge => {
        const icon = badge.querySelector('i');
        const valueSpan = badge.querySelector('span[class*="font-GeistMono"], span:not(:empty)');
        if (!icon || !valueSpan) return;

        const iconClass = icon.className || '';
        const value = valueSpan.textContent?.trim();
        const isRed = iconClass.includes('text-primaryRed') || valueSpan.className?.includes('text-primaryRed');

        if (iconClass.includes('ri-user-star-line')) {
          result.topHolders = value;
          result.topHoldersRisk = isRed;
        } else if (iconClass.includes('icon-chef-hat')) {
          result.insiderPct = value;
          result.insiderRisk = isRed;
        } else if (iconClass.includes('ri-crosshair-2-line')) {
          result.sniperPct = value;
          result.sniperRisk = isRed;
        } else if (iconClass.includes('ri-ghost-line')) {
          result.botPct = value;
          result.botRisk = isRed;
        } else if (iconClass.includes('icon-boxes')) {
          result.bundlePct = value;
          result.bundleRisk = isRed;
        } else if (iconClass.includes('icon-dex-paid')) {
          result.dexPaid = value;
          result.dexPaidRisk = value === 'Unpaid';
        } else if (iconClass.includes('ri-user-line')) {
          result.holders = value;
        } else if (iconClass.includes('icon-pro-trader')) {
          result.proTraders = value;
        }
      });

      return result;
    }

    // Start
    findAndAttach();

    // SPA URL change detection
    let lastUrl = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        if (isDiscoverPage(lastUrl)) {
          console.log(`${TAG} 🔄 URL changed, re-attaching...`);
          retries = 0;
          knownTokens.clear();
          findAndAttach();
        }
      }
    }, 2000);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SECONDARY OBSERVER — Token Detail Page
  // ═══════════════════════════════════════════════════════════════════

  function startSecondaryObserver() {
    const tokenPath = window.location.pathname;
    console.log(`${TAG} 🔵 Monitoring token: ${tokenPath}`);

    const POLL_INTERVAL = 2000;
    const MAX_POLLS = 20;
    let polls = 0;

    function pollForData() {
      polls++;
      const data = extractTokenDetail();
      if (data && Object.values(data).some(v => v !== null && v !== false)) {
        console.log(`${TAG} 📊 Token detail:`, data);
        chrome.runtime.sendMessage({ type: 'SECONDARY_DATA', tokenPath, data, timestamp: Date.now() });
        attachDetailObserver();
        return;
      }
      if (polls < MAX_POLLS) setTimeout(pollForData, POLL_INTERVAL);
      else attachDetailObserver();
    }

    function attachDetailObserver() {
      const target = document.getElementById('platform-layout-container') || document.body;
      const sendUpdate = MemeUtils.throttle(() => {
        const data = extractTokenDetail();
        if (data) chrome.runtime.sendMessage({ type: 'SECONDARY_DATA', tokenPath, data, timestamp: Date.now() });
      }, 3000);
      const obs = new MutationObserver(sendUpdate);
      obs.observe(target, { childList: true, subtree: true, characterData: true });
    }

    function extractTokenDetail() {
      const detail = { price: null, marketCap: null, liquidity: null, volume24h: null, holders: null, isRugRisk: false, rugIndicators: [] };
      try {
        const pageText = document.body.innerText.toLowerCase();
        ['honeypot', 'mint authority enabled', 'freeze authority enabled'].forEach(term => {
          if (pageText.includes(term)) { detail.isRugRisk = true; detail.rugIndicators.push(term); }
        });
      } catch (err) { /* skip */ }
      return detail;
    }

    chrome.runtime.sendMessage({ type: 'SECONDARY_TAB_READY', tokenPath, tabUrl: window.location.href });
    pollForData();
  }
})();
