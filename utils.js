/**
 * MemeScanner Pro V4 — Shared Architectural Utilities
 * 
 * - Standardized Selector Schema for multi-platform resilience
 * - High-precision numerical parsing
 * - Filter engine V4 with GMGN-specific metric support
 */

const MemeUtils = (() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────
  //  DYNAMIC SELECTOR SCHEMA (V4)
  // ───────────────────────────────────────────────────────────────

  const SELECTORS = {
    axiom: {
      container: 'section[aria-label="Table content"] div[style*="height"]',
      row: 'div[data-index]',
      ticker: 'span[class*="text-textPrimary"] div.truncate',
      name: 'div[role="button"] span div.truncate',
      age: 'span[class*="text-primaryGreen"]',
      marketCap: 'span[class*="text-textPrimary"]',
      mcChange: 'span[class*="font-GeistMono"]'
    },
    gmgn: {
      container: '.g-table-body',
      row: 'div[data-index]',
      ticker: "span[data-sentry-component='TooltipCopy']",
      name: "div[data-sentry-component='TokenBaseInfo'] div.truncate",
      age: 'div.text-green-50',
      volumeContainer: "div[data-sentry-component='Volume']",
      flowContainer: "div[class*='pl-[2px]']",
      holderView: "div[data-sentry-component='HolderView']",
      twitter: "a[aria-label='twitter']",
      website: "a[aria-label='website']"
    }
  };

  /**
   * Safe DOM Query Utility with Error Boundaries.
   */
  function safeQuery(parent, selector, label = 'Unknown') {
    try {
      const el = parent.querySelector(selector);
      if (!el) throw new Error(`Selector "${selector}" not found for ${label}`);
      return el;
    } catch (err) {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────
  //  NUMERICAL PARSING
  // ───────────────────────────────────────────────────────────────

  function parseAge(text) {
    if (!text || typeof text !== 'string') return Infinity;
    const cleaned = text.trim().toLowerCase();
    const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
    if (!match) return Infinity;
    const value = parseFloat(match[1]);
    const unit = match[2];
    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      case 'd': return value * 86400;
      default: return Infinity;
    }
  }

  function parseValue(text) {
    if (!text || typeof text !== 'string') return 0;
    const cleaned = text.trim().replace(/[$,]/g, '').toUpperCase();
    const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(K|M|B|T)?$/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const suffix = match[2];
    switch (suffix) {
      case 'K': return value * 1_000;
      case 'M': return value * 1_000_000;
      case 'B': return value * 1_000_000_000;
      case 'T': return value * 1_000_000_000_000;
      default: return value;
    }
  }

  function parsePercent(text) {
    if (!text || typeof text !== 'string') return NaN;
    const match = text.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : NaN;
  }

  // ───────────────────────────────────────────────────────────────
  //  FILTER ENGINE V4
  // ───────────────────────────────────────────────────────────────

  function matchesFilters(token, filters) {
    const reasons = [];
    if (!filters.enabled) return { passed: true, reasons: [] };

    const tokenSearchText = `${token.ticker || ''} ${token.name || ''}`.toLowerCase();

    if (Array.isArray(filters.searchKeywords) && filters.searchKeywords.length > 0) {
      const matchesSearch = filters.searchKeywords.some((kw) => tokenSearchText.includes(String(kw).toLowerCase()));
      if (!matchesSearch) reasons.push('Search keywords not matched');
    }

    if (Array.isArray(filters.excludeKeywords) && filters.excludeKeywords.length > 0) {
      const hasExcluded = filters.excludeKeywords.some((kw) => tokenSearchText.includes(String(kw).toLowerCase()));
      if (hasExcluded) reasons.push('Excluded keyword matched');
    }

    // Protocol Check
    if (filters.protocols) {
      const platform = (token.platform || '').toLowerCase().replace(/\s+/g, '');
      const protoKey = platform === 'believe' ? 'launchACoin' : platform;
      if (filters.protocols[protoKey] === false) {
        reasons.push(`Protocol ${token.platform} disabled`);
      }
    }

    // Range Validation Utility
    const validateRange = (val, range, label) => {
      if (!range) return;
      const num = typeof val === 'string' ? parseValue(val) : val;
      if (range.min && num < range.min) reasons.push(`${label} ${val} < ${range.min}`);
      if (range.max && num > range.max) reasons.push(`${label} ${val} > ${range.max}`);
    };

    // Age unit-aware check
    if (filters.age) {
      let ageSec = parseAge(token.age);
      let minS = (filters.age.min || 0) * (filters.age.unit === 'minutes' ? 60 : (filters.age.unit === 'hours' ? 3600 : 1));
      let maxS = (filters.age.max || 0) * (filters.age.unit === 'minutes' ? 60 : (filters.age.unit === 'hours' ? 3600 : 1));
      if (minS > 0 && ageSec < minS) reasons.push(`Age < ${filters.age.min}${filters.age.unit}`);
      if (maxS > 0 && ageSec > maxS) reasons.push(`Age > ${filters.age.max}${filters.age.unit}`);
    }

    validateRange(token.marketCap, filters.marketCap, 'MC');
    validateRange(token.liquidity, filters.liquidity, 'Liq');
    validateRange(token.volume, filters.volume, 'Vol');
    validateRange(token.holders, filters.holdersCount, 'Holders');
    validateRange(token.topHolders, filters.top10Holders, 'Top10');
    validateRange(token.bundlePct, filters.bundlersPercentage, 'Bundlers');

    // New V4 filters for GMGN-specific data
    if (filters.requireSocials && !token.socialLink && !token.twitterHandle) {
      reasons.push('No social links');
    }

    if (filters.minSmartMoney) {
      const sm = Number(token.smartMoney || 0);
      if (sm < filters.minSmartMoney) reasons.push(`SmartMoney ${sm} < ${filters.minSmartMoney}`);
    }

    if (filters.minTwitterFollowers) {
      const followers = parseValue(token.twitterFollowers || '0');
      if (followers < filters.minTwitterFollowers) reasons.push(`Followers ${token.twitterFollowers} < ${filters.minTwitterFollowers}`);
    }

    return { passed: reasons.length === 0, reasons };
  }

  function formatTimestamp(ms) {
    const d = ms ? new Date(ms) : new Date();
    return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  return {
    SELECTORS,
    safeQuery,
    parseAge,
    parseValue,
    parsePercent,
    matchesFilters,
    formatTimestamp
  };
})();

// Bridge for SW and CS
if (typeof globalThis !== 'undefined') globalThis.MemeUtils = MemeUtils;
if (typeof module !== 'undefined') module.exports = MemeUtils;
