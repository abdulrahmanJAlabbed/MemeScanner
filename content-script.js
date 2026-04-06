(() => {
  'use strict';

  const EXT_TAG = '[MemeScanner Content]';

  const FALLBACK_PRESETS = {
    axiom: {
      hosts: ['axiom.trade'],
      listContainer: "section[aria-label='Table content']",
      row: 'div[data-index]',
      layout: 'table',
      auditRules: ['honeypot', 'mintAuthorityEnabled', 'freezeAuthorityEnabled']
    },
    gmgn: {
      hosts: ['gmgn.ai'],
      listContainer: '.g-table-body',
      row: 'div[data-index]',
      layout: 'card',
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

  // ─── Shared utilities ─────────────────────────────────────────

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

    const tokenImage = row.querySelector("img[src*='axiomtrading'],img[src*='axiom-assets'],img[src*='cdn']");
    if (tokenImage) {
      const src = tokenImage.getAttribute('src') || '';
      const fromSrc = extractAddressFromText(src);
      if (fromSrc) {
        return fromSrc;
      }
    }

    const rowTextMatch = extractAddressFromText(row.textContent || '');
    if (rowTextMatch) {
      return rowTextMatch;
    }

    return '';
  }

  function detectPlatform(row) {
    // Axiom badges
    const badgeIcon = row.querySelector('img[alt="Pump"],img[alt="Raydium"],img[alt="BONK"],img[alt="Moonshot"]');
    if (badgeIcon) {
      return sanitizeText(badgeIcon.getAttribute('alt')).toLowerCase();
    }

    // GMGN: pump.fun link presence
    const pumpLink = row.querySelector('a[href*="pump.fun"]');
    if (pumpLink) return 'pump';

    const text = sanitizeText(row.innerText || '').toLowerCase();
    if (text.includes('pump.fun')) return 'pump';
    if (text.includes('raydium')) return 'raydium';
    if (text.includes('bonk')) return 'bonk';
    return '';
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

  // ─── Axiom-specific extraction (existing logic, untouched) ────

  function extractAxiomAuditBadges(auditColumn) {
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

  function extractAxiomTransactions(txColumn) {
    if (!txColumn) {
      return { txTotal: '', txBuys: '', txSells: '' };
    }

    const txTotal = sanitizeText(txColumn.querySelector("span[class*='text-textPrimary']")?.textContent || '');
    const txBuys = sanitizeText(txColumn.querySelector("span[class*='text-increase']")?.textContent || '');
    const txSells = sanitizeText(txColumn.querySelector("span[class*='text-decrease']")?.textContent || '');
    return { txTotal, txBuys, txSells };
  }

  function parseAxiomRow(row, presetName, auditRules, fallbackOrder = 0) {
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
    const tx = extractAxiomTransactions(txCol);
    const auditBadges = extractAxiomAuditBadges(auditCol);
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

  // ─── GMGN-specific extraction (NEW) ──────────────────────────

  /**
   * Extract the labeled value pairs from GMGN's Volume component.
   * Structure: multiple child divs, each with a label span ("V","MC") and a value span.
   */
  function extractGmgnVolumeBlock(row) {
    const result = { volume: '', marketCap: '' };
    const volumeContainer = row.querySelector("div[data-sentry-component='Volume']");
    if (!volumeContainer) return result;

    const items = volumeContainer.querySelectorAll(':scope > div');
    items.forEach((item) => {
      const label = sanitizeText(item.querySelector('span.text-text-300')?.textContent || '').toUpperCase();
      const valueSpans = item.querySelectorAll('span');
      const valueCandidates = Array.from(valueSpans).filter(
        (s) => !s.classList.contains('text-text-300') && sanitizeText(s.textContent)
      );
      const value = sanitizeText(valueCandidates[valueCandidates.length - 1]?.textContent || '');
      if (label === 'V') result.volume = value;
      if (label === 'MC') result.marketCap = value;
    });

    return result;
  }

  /**
   * Extract the flow row: Funding (F), Net Flow (N), TX count with buy/sell ratio.
   */
  function extractGmgnFlowBlock(row) {
    const result = { funding: '', netFlow: '', txTotal: '', txBuys: '', txSells: '', buyRatio: '' };

    // The flow row is the div with pl-[2px] class that contains F, N, TX labels
    const flowContainers = row.querySelectorAll("div[class*='pl-[2px]']");
    for (const container of flowContainers) {
      const innerItems = container.querySelectorAll(':scope > div, :scope > span');
      innerItems.forEach((item) => {
        const text = sanitizeText(item.textContent || '');
        const label = sanitizeText(item.querySelector('span.text-text-300, div.text-text-300')?.textContent || '').toUpperCase();

        if (label === 'F') {
          const valNode = item.querySelector('span.text-text-100');
          result.funding = sanitizeText(valNode?.textContent || '');
        }
        if (label === 'N') {
          const valNode = item.querySelector('span.text-increase-100, span.text-decrease-100, span.text-text-100');
          result.netFlow = sanitizeText(valNode?.textContent || '');
        }
        if (label === 'TX') {
          const valNode = item.querySelector('span.text-text-100');
          result.txTotal = sanitizeText(valNode?.textContent || '');

          // The buy/sell ratio is encoded in the gradient bar
          const barEl = item.querySelector("div[style*='linear-gradient']");
          if (barEl) {
            const style = barEl.getAttribute('style') || '';
            const pctMatch = style.match(/(\d+(?:\.\d+)?)%/);
            if (pctMatch) {
              const buyPct = parseFloat(pctMatch[1]);
              result.buyRatio = `${buyPct}%`;
              const total = Number(result.txTotal) || 0;
              if (total > 0) {
                result.txBuys = String(Math.round(total * buyPct / 100));
                result.txSells = String(total - Number(result.txBuys));
              }
            }
          }
        }
      });
    }

    return result;
  }

  /**
   * Extract holder metrics from GMGN's HolderView component.
   * These are the icon+number pairs: smart money, KOL, pump replies, holders, bots, watchers.
   */
  function extractGmgnHolderMetrics(row) {
    const result = {
      smartMoney: '',
      smartDegen: '',
      pumpReplies: '',
      holders: '',
      botCount: '',
      watchers: ''
    };

    const holderView = row.querySelector("div[data-sentry-component='HolderView']");
    if (!holderView) return result;

    const groups = holderView.querySelectorAll(':scope > div');
    const values = [];
    groups.forEach((group) => {
      const spans = group.querySelectorAll('span');
      const lastSpan = spans[spans.length - 1];
      if (lastSpan) {
        values.push(sanitizeText(lastSpan.textContent || ''));
      }
    });

    // GMGN HolderView order: smart money, KOL/degen, pump replies, holders, bots, watchers
    if (values.length >= 1) result.smartMoney = values[0];
    if (values.length >= 2) result.smartDegen = values[1];
    if (values.length >= 3) result.pumpReplies = values[2];
    if (values.length >= 4) result.holders = values[3];
    if (values.length >= 5) result.botCount = values[4];
    if (values.length >= 6) result.watchers = values[5];

    return result;
  }

  /**
   * Extract the bottom tag badges: dev%, bundler%, insider%, rat%, bluechip%, top holders%.
   * These are pill-shaped elements with SVG icons and percentage text.
   */
  function extractGmgnTagBadges(row) {
    const result = {
      devSoldPct: '',
      devSoldAge: '',
      ratPct: '',
      bundlePct: '',
      insiderPct: '',
      bluechipPct: '',
      topHoldersPct: '',
      sniperPct: '',
      targetPct: ''
    };

    // The badge row is the flex container with h-[24px] gap-[4px]
    const badgeRows = row.querySelectorAll("div[class*='h-[24px]'][class*='gap-[4px]'][class*='font-medium']");
    for (const badgeRow of badgeRows) {
      const badges = badgeRow.querySelectorAll(':scope > div');
      const extractedValues = [];

      badges.forEach((badge) => {
        const innerDiv = badge.querySelector('div[style*="transform"]') || badge;
        const textParts = [];
        innerDiv.querySelectorAll('span, div:not(:has(svg))').forEach((el) => {
          const t = sanitizeText(el.textContent || '');
          if (t) textParts.push(t);
        });

        // Get the raw text next to the SVG icon
        let rawText = sanitizeText(innerDiv.textContent || '');
        extractedValues.push(rawText);
      });

      // GMGN badge order: Star(devHolding%), Cloud(devSold), Rat%, Bundle%, Insider%, Sniper%, Plant%, Target%
      if (extractedValues.length >= 1) result.devSoldPct = extractedValues[0];
      if (extractedValues.length >= 2) {
        // Dev sold badge often includes age like "DS 16s" or just "0%"
        const ds = extractedValues[1];
        const dsMatch = ds.match(/DS\s*(.+)/i);
        if (dsMatch) {
          result.devSoldAge = dsMatch[1];
        } else {
          result.devSoldAge = ds;
        }
      }
      if (extractedValues.length >= 3) result.ratPct = extractedValues[2];
      if (extractedValues.length >= 4) result.bundlePct = extractedValues[3];
      if (extractedValues.length >= 5) result.insiderPct = extractedValues[4];
      if (extractedValues.length >= 6) result.sniperPct = extractedValues[5];
      if (extractedValues.length >= 7) result.bluechipPct = extractedValues[6];
      if (extractedValues.length >= 8) result.topHoldersPct = extractedValues[7];
    }

    return result;
  }

  /**
   * Extract Twitter handle and follower count from GMGN cards.
   */
  function extractGmgnSocials(row) {
    const result = { twitterHandle: '', twitterFollowers: '', socialLink: '', websiteLink: '' };

    // Twitter handle: the @username link
    const twitterHandleEl = row.querySelector("a[aria-label='twitter'][class*='text-xblue-100']");
    if (twitterHandleEl) {
      result.twitterHandle = sanitizeText(twitterHandleEl.textContent || '');
    }

    // Twitter link
    const twitterLink = row.querySelector("a[aria-label='twitter']");
    if (twitterLink) {
      result.socialLink = sanitizeText(twitterLink.getAttribute('href') || '');
    }

    // Website link
    const websiteLink = row.querySelector("a[aria-label='website']");
    if (websiteLink) {
      result.websiteLink = sanitizeText(websiteLink.getAttribute('href') || '');
    }

    // Follower count: the span near the people icon in the row below the handle
    const followerSpans = row.querySelectorAll("span[class*='text-[11px]'][class*='font-[500]']");
    followerSpans.forEach((span) => {
      const text = sanitizeText(span.textContent || '');
      // Pick the one that looks like a follower count (e.g., "1.9K", "454.6K", "0")
      if (/^[\d.,]+[KMB]?$/i.test(text)) {
        result.twitterFollowers = text;
      }
    });

    return result;
  }

  /**
   * Main GMGN row parser — extracts all available data from a GMGN card.
   */
  function parseGmgnRow(row, presetName, auditRules, fallbackOrder = 0) {
    // Ticker
    const tickerNode = row.querySelector("span[data-sentry-component='TooltipCopy']");
    const ticker = sanitizeText(tickerNode?.textContent || '');
    if (!ticker) return null;

    // Name
    const nameContainer = row.querySelector("div[data-sentry-component='TokenBaseInfo']");
    const nameNode = nameContainer?.querySelector('div.truncate');
    const name = sanitizeText(nameNode?.textContent || '');

    // Age
    const ageNode = row.querySelector('div.text-green-50');
    const age = sanitizeText(ageNode?.textContent || '');
    const ageSeconds = parseAgeToSeconds(age);

    // Contract address from links
    const contractAddress = extractContractAddress(row);
    const tokenLinks = collectTokenLinks(row);
    const detailsLink = tokenLinks.find((href) => /\/coin\/|\/token\/|\/t\//i.test(href)) || '';

    // Volume & Market Cap
    const volumeData = extractGmgnVolumeBlock(row);

    // Flow row: Funding, Net Flow, TX
    const flowData = extractGmgnFlowBlock(row);

    // Holder metrics
    const holderMetrics = extractGmgnHolderMetrics(row);

    // Tag badges (dev%, bundler%, etc.)
    const tagBadges = extractGmgnTagBadges(row);

    // Socials
    const socials = extractGmgnSocials(row);

    // Platform detection
    const platform = detectPlatform(row) || presetName;

    // Audit
    const audit = runAuditSuite(row, auditRules);

    // Token identity
    const tokenId = contractAddress || `${presetName}:${ticker}`;
    const dataIndex = Number(row?.dataset?.index);
    const pageOrder = Number.isFinite(dataIndex) ? dataIndex : fallbackOrder;

    // Velocity calculation
    const txBuysN = Number(flowData.txBuys || 0);
    const txSellsN = Number(flowData.txSells || 0);
    const txTotalN = Number(flowData.txTotal || txBuysN + txSellsN || 0);
    const velocityScore = Number.isFinite(ageSeconds) && ageSeconds > 0
      ? (Math.max(0, txBuysN - txSellsN) / Math.max(1, txTotalN)) * (txTotalN / ageSeconds)
      : null;

    return {
      tokenId,
      contractAddress,
      ticker,
      name,
      age,
      ageSeconds,
      marketCap: volumeData.marketCap,
      liquidity: flowData.funding,
      volume: volumeData.volume,
      txTotal: flowData.txTotal,
      txBuys: flowData.txBuys,
      txSells: flowData.txSells,
      buyRatio: flowData.buyRatio,
      netFlow: flowData.netFlow,
      funding: flowData.funding,
      velocityScore,
      // Holder metrics
      smartMoney: holderMetrics.smartMoney,
      smartDegen: holderMetrics.smartDegen,
      pumpReplies: holderMetrics.pumpReplies,
      holders: holderMetrics.holders,
      botCount: holderMetrics.botCount,
      watchers: holderMetrics.watchers,
      // Tag badges
      topHolders: tagBadges.topHoldersPct,
      top10Pct: tagBadges.topHoldersPct,
      insiderPct: tagBadges.insiderPct,
      bundlePct: tagBadges.bundlePct,
      bundlersPct: tagBadges.bundlePct,
      devPct: tagBadges.devSoldPct,
      devSoldAge: tagBadges.devSoldAge,
      ratPct: tagBadges.ratPct,
      sniperPct: tagBadges.sniperPct,
      bluechipPct: tagBadges.bluechipPct,
      dexPaid: '',
      proTraders: '',
      lpBurned: null,
      // Socials
      socialLink: socials.socialLink,
      twitterHandle: socials.twitterHandle,
      twitterFollowers: socials.twitterFollowers,
      websiteLink: socials.websiteLink,
      // Navigation
      detailsLink,
      tokenLinks,
      platform,
      pageOrder,
      audit,
      updatedAt: Date.now()
    };
  }

  // ─── Dispatcher ───────────────────────────────────────────────

  function parseRow(row, presetName, auditRules, fallbackOrder = 0) {
    if (presetName === 'gmgn') {
      return parseGmgnRow(row, presetName, auditRules, fallbackOrder);
    }
    return parseAxiomRow(row, presetName, auditRules, fallbackOrder);
  }

  // ─── Diffing & batch helpers ──────────────────────────────────

  function buildFingerprint(token) {
    return [
      token.marketCap,
      token.liquidity,
      token.volume,
      token.age,
      token.netFlow || '',
      token.txTotal || '',
      token.holders || '',
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
