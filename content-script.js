(() => {
  'use strict';

  const EXT_TAG = '[MemeScanner Content]';

  const FALLBACK_PRESETS = {
    axiom: {
      hosts: ['axiom.trade'],
      listContainer: "section[aria-label='Table content']",
      row: 'div[data-index]',
      auditRules: ['honeypot', 'mintAuthorityEnabled', 'freezeAuthorityEnabled']
    },
    gmgn: {
      hosts: ['gmgn.ai'],
      listContainer: '#GlobalScrollDomId',
      row: 'div[data-index]',
      auditRules: ['honeypot', 'mintAuthorityEnabled']
    }
  };

  let runtimeScraperConfig = {
    updateIntervalMs: 250,
    debounceMs: 140,
    maxTokensPerBatch: 120,
    platformPresets: FALLBACK_PRESETS
  };

  function getManifestScraperConfig() {
    return runtimeScraperConfig;
  }

  async function loadScraperConfig() {
    try {
      const url = chrome.runtime.getURL('scraper-config.json');
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        return;
      }

      const config = await response.json();
      runtimeScraperConfig = {
        ...runtimeScraperConfig,
        ...config,
        platformPresets: config?.platformPresets || FALLBACK_PRESETS
      };
    } catch (error) {
      console.debug(`${EXT_TAG} using fallback scraper config`);
    }
  }

  function getPresetForHost(hostname) {
    const config = getManifestScraperConfig();
    const presets = config.platformPresets || FALLBACK_PRESETS;

    for (const [presetName, preset] of Object.entries(presets)) {
      const hosts = Array.isArray(preset.hosts) ? preset.hosts : [];
      const matched = hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
      if (matched) {
        return { name: presetName, ...preset };
      }
    }

    return null;
  }

  function sanitizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function parseAgeToSeconds(text) {
    const cleaned = sanitizeText(text).toLowerCase();
    const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return null;
    const unit = match[2];
    if (unit === 's') return value;
    if (unit === 'm') return value * 60;
    if (unit === 'h') return value * 3600;
    if (unit === 'd') return value * 86400;
    return null;
  }

  function isLikelyMintAddress(value) {
    if (!value) return false;
    const cleaned = String(value).trim();

    // Common meme mint form (ending in pump) and generic Solana-style addresses.
    if (/^[A-Za-z0-9]{24,}pump$/i.test(cleaned)) return true;
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cleaned)) return true;
    return false;
  }

  function extractAddressFromText(value) {
    const text = String(value || '');
    const matches = text.match(/[A-Za-z0-9]{24,}pump|[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
    for (const candidate of matches) {
      if (isLikelyMintAddress(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  function collectTokenLinks(row) {
    const links = [];
    const seen = new Set();

    row.querySelectorAll('a[href]').forEach((anchor) => {
      const href = sanitizeText(anchor.getAttribute('href') || '');
      if (!href || seen.has(href)) return;
      seen.add(href);
      links.push(href);
    });

    return links;
  }

  function extractContractAddress(row) {
    const links = collectTokenLinks(row);

    for (const href of links) {
      const directMatch = href.match(/(?:\/coin\/|\/token\/|\/t\/)([A-Za-z0-9]{20,})/i);
      if (directMatch?.[1] && isLikelyMintAddress(directMatch[1])) {
        return directMatch[1];
      }

      const pumpMatch = href.match(/pump\.fun\/coin\/([A-Za-z0-9]{20,})/i);
      if (pumpMatch?.[1] && isLikelyMintAddress(pumpMatch[1])) {
        return pumpMatch[1];
      }

      const fromText = extractAddressFromText(href);
      if (fromText) {
        return fromText;
      }
    }

    // Fallback: many rows embed the mint in image URLs.
    const tokenImage = row.querySelector("img[src*='axiomtrading'],img[src*='axiom-assets'],img[src*='cdn']");
    if (tokenImage) {
      const src = tokenImage.getAttribute('src') || '';
      const fromSrc = extractAddressFromText(src);
      if (fromSrc) {
        return fromSrc;
      }
    }

    // Last fallback: scan raw row text for a candidate address.
    const rowTextMatch = extractAddressFromText(row.textContent || '');
    if (rowTextMatch) {
      return rowTextMatch;
    }

    return '';
  }

  function detectPlatform(row) {
    const badgeIcon = row.querySelector('img[alt="Pump"],img[alt="Raydium"],img[alt="BONK"],img[alt="Moonshot"]');
    if (badgeIcon) {
      return sanitizeText(badgeIcon.getAttribute('alt')).toLowerCase();
    }

    const text = sanitizeText(row.innerText || '').toLowerCase();
    if (text.includes('pump.fun')) return 'pump';
    if (text.includes('raydium')) return 'raydium';
    if (text.includes('bonk')) return 'bonk';
    return '';
  }

  function extractAuditBadges(auditColumn) {
    const result = {
      topHolders: '',
      insiderPct: '',
      sniperPct: '',
      botPct: '',
      bundlePct: '',
      dexPaid: '',
      holders: '',
      proTraders: ''
    };

    if (!auditColumn) {
      return result;
    }

    const badges = auditColumn.querySelectorAll("div[class*='min-h-[16px]'],div[class*='max-h-[16px]']");
    badges.forEach((badge) => {
      const icon = badge.querySelector('i');
      const value = sanitizeText(badge.querySelector('span')?.textContent || '');
      if (!icon || !value) {
        return;
      }

      const iconClass = icon.className || '';
      if (iconClass.includes('ri-user-star-line')) result.topHolders = value;
      if (iconClass.includes('icon-chef-hat')) result.insiderPct = value;
      if (iconClass.includes('ri-crosshair-2-line')) result.sniperPct = value;
      if (iconClass.includes('ri-ghost-line')) result.botPct = value;
      if (iconClass.includes('icon-boxes')) result.bundlePct = value;
      if (iconClass.includes('icon-dex-paid')) result.dexPaid = value;
      if (iconClass.includes('ri-user-line')) result.holders = value;
      if (iconClass.includes('icon-pro-trader')) result.proTraders = value;
    });

    return result;
  }

  function extractTransactions(txColumn) {
    if (!txColumn) {
      return { txTotal: '', txBuys: '', txSells: '' };
    }

    const txTotal = sanitizeText(txColumn.querySelector("span[class*='text-textPrimary']")?.textContent || '');
    const txBuys = sanitizeText(txColumn.querySelector("span[class*='text-increase']")?.textContent || '');
    const txSells = sanitizeText(txColumn.querySelector("span[class*='text-decrease']")?.textContent || '');
    return { txTotal, txBuys, txSells };
  }

  function runAuditSuite(row, rules) {
    const text = sanitizeText(row?.innerText || '').toLowerCase();
    const findings = [];

    if (!Array.isArray(rules)) {
      return { riskScore: 0, findings };
    }

    if (rules.includes('honeypot') && /honeypot/.test(text)) {
      findings.push('Honeypot mention detected');
    }

    if (rules.includes('mintAuthorityEnabled') && /mint authority\s*(enabled|on|true)/.test(text)) {
      findings.push('Mint authority enabled');
    }

    if (rules.includes('freezeAuthorityEnabled') && /freeze authority\s*(enabled|on|true)/.test(text)) {
      findings.push('Freeze authority enabled');
    }

    const riskScore = Math.min(100, findings.length * 30);
    return { riskScore, findings };
  }

  function parseRow(row, presetName, auditRules, fallbackOrder = 0) {
    const flexRow = row.querySelector('.group > div') || row;
    const directColumns = Array.from(flexRow.children || []);

    const infoCol =
      directColumns.find((node) => /w-\[224px\]|w-\[320px\]/.test(node.className || '')) ||
      directColumns[0] ||
      flexRow;
    const infoIndex = Math.max(0, directColumns.indexOf(infoCol));
    const marketCapCol = directColumns[infoIndex + 2] || null;
    const liquidityCol = directColumns[infoIndex + 3] || null;
    const volumeCol = directColumns[infoIndex + 4] || null;
    const txCol = directColumns[infoIndex + 5] || null;
    const auditCol = directColumns[infoIndex + 6] || null;

    const tickerNode =
      infoCol.querySelector('span.text-textPrimary div.truncate, span[class*="text-textPrimary"] div.truncate') ||
      infoCol.querySelector('div.truncate,.ticker,[data-ticker]');
    const nameNode =
      infoCol.querySelector('div[role="button"] span.text-inherit div.truncate, div[role="button"] span div.truncate') ||
      infoCol.querySelector('span div.truncate,.name,[data-token-name]');
    const ageNode = infoCol.querySelector("span[class*='text-primaryGreen'],.age,[data-age]");

    const ticker = sanitizeText(tickerNode?.textContent || '');
    if (!ticker || ticker.startsWith('$')) {
      return null;
    }

    const marketCap = sanitizeText(
      marketCapCol?.querySelector("span[class*='text-textPrimary']")?.textContent ||
        row.querySelector("[data-mc],.mc")?.textContent ||
        ''
    );
    const liquidity = sanitizeText(
      liquidityCol?.querySelector("span[class*='text-textPrimary']")?.textContent ||
        row.querySelector("[data-liq],.liq")?.textContent ||
        ''
    );
    const volume = sanitizeText(
      volumeCol?.querySelector("span[class*='text-textPrimary']")?.textContent ||
        row.querySelector("[data-volume],.volume")?.textContent ||
        ''
    );
    const tx = extractTransactions(txCol);
    const auditBadges = extractAuditBadges(auditCol);
    const platform = detectPlatform(row) || presetName;

    const tokenLinks = collectTokenLinks(row);
    const contractAddress = extractContractAddress(row);
    const detailsLink = tokenLinks.find((href) => /\/coin\/|\/token\/|\/t\//i.test(href)) || '';
    const socialLink = tokenLinks.find((href) => /x\.com|twitter\.com/i.test(href)) || '';
    const audit = runAuditSuite(row, auditRules);
    const tokenId = contractAddress || `${presetName}:${ticker}`;
    const dataIndex = Number(row?.dataset?.index);
    const pageOrder = Number.isFinite(dataIndex) ? dataIndex : fallbackOrder;
    const age = sanitizeText(ageNode?.textContent || '');
    const ageSeconds = parseAgeToSeconds(age);
    const txBuysN = Number(tx.txBuys || 0);
    const txSellsN = Number(tx.txSells || 0);
    const txTotalN = Number(tx.txTotal || txBuysN + txSellsN || 0);
    const velocityScore = Number.isFinite(ageSeconds) && ageSeconds > 0
      ? (Math.max(0, txBuysN - txSellsN) / Math.max(1, txTotalN)) * (txTotalN / ageSeconds)
      : null;

    return {
      tokenId,
      contractAddress,
      ticker,
      name: sanitizeText(nameNode?.textContent || ''),
      age,
      ageSeconds,
      marketCap,
      liquidity,
      volume,
      ...tx,
      velocityScore,
      ...auditBadges,
      top10Pct: auditBadges.topHolders || '',
      bundlersPct: auditBadges.bundlePct || '',
      devPct: auditBadges.insiderPct || '',
      // Keep null when unavailable to avoid false assumptions in execution logic.
      lpBurned: null,
      detailsLink,
      socialLink,
      tokenLinks,
      platform,
      pageOrder,
      audit,
      updatedAt: Date.now()
    };
  }

  function buildFingerprint(token) {
    return [
      token.marketCap,
      token.liquidity,
      token.volume,
      token.age,
      token.audit?.riskScore || 0,
      token.pageOrder
    ].join('|');
  }

  function patchChangedTokens(previousMap, nextTokens, options = {}) {
    const skipRemoval = !!options.skipRemoval;
    const nextMap = new Map(previousMap);
    const changed = [];
    const removed = [];

    for (const token of nextTokens) {
      const key = token.tokenId;
      const nextFingerprint = buildFingerprint(token);
      const previousFingerprint = nextMap.get(key);

      if (previousFingerprint !== nextFingerprint) {
        changed.push(token);
        nextMap.set(key, nextFingerprint);
      }
    }

    if (!skipRemoval) {
      const nextKeys = new Set(nextTokens.map((token) => token.tokenId));
      for (const key of nextMap.keys()) {
        if (!nextKeys.has(key)) {
          removed.push(key);
          nextMap.delete(key);
        }
      }
    }

    return { changed, removed, nextMap };
  }

  function safeExtractTokens(root, preset) {
    try {
      const rows = root.querySelectorAll(preset.row || 'div[data-index]');
      return safeExtractTokensFromRows(rows, preset);
    } catch (error) {
      console.warn(`${EXT_TAG} extraction failed`, error);
      return [];
    }
  }

  function safeExtractTokensFromRows(rows, preset) {
    try {
      const parsed = [];
      const rowList = Array.from(rows || []);

      rowList.forEach((row, index) => {
        if (!(row instanceof Element)) {
          return;
        }
        const fallbackOrder = Number.isFinite(Number(row?.dataset?.index)) ? Number(row.dataset.index) : index;
        const token = parseRow(row, preset.name || 'unknown', preset.auditRules || [], fallbackOrder);
        if (token) {
          parsed.push(token);
        }
      });

      return parsed;
    } catch (error) {
      console.warn(`${EXT_TAG} row extraction failed`, error);
      return [];
    }
  }

  globalThis.MemeScannerContent = {
    getPresetForHost,
    safeExtractTokens,
    safeExtractTokensFromRows,
    patchChangedTokens,
    getManifestScraperConfig
  };

  loadScraperConfig();
})();
