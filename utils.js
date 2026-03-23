/**
 * MemeScanner — Shared Utilities
 * Parsing helpers used by both content scripts and background worker.
 */

const MemeUtils = (() => {
  /**
   * Parse age string to seconds.
   * Examples: "0s" → 0, "30s" → 30, "5m" → 300, "2h" → 7200, "1d" → 86400
   */
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

  /**
   * Parse value string to a raw number.
   * Examples: "$1.2K" → 1200, "$5M" → 5000000, "500" → 500, "$123" → 123
   */
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

  /**
   * Parse transaction count text. Handles "1.2K" style.
   */
  function parseTxCount(text) {
    return parseValue(text);
  }

  /**
   * Check if a token matches the given filter configuration.
   * Returns { passed: boolean, reasons: string[] }
   */
  function matchesFilters(token, filters) {
    const reasons = [];

    // Age filter: token must be younger than maxAge
    if (filters.maxAge !== undefined && filters.maxAge > 0) {
      const ageSeconds = parseAge(token.age);
      if (ageSeconds > filters.maxAge) {
        reasons.push(`Age ${token.age} exceeds max ${filters.maxAge}s`);
      }
    }

    // Volume filter
    if (filters.minVolume !== undefined && filters.minVolume > 0) {
      const vol = parseValue(token.volume);
      if (vol < filters.minVolume) {
        reasons.push(`Volume ${token.volume} below min $${filters.minVolume}`);
      }
    }

    // Market cap filter
    if (filters.minMC !== undefined && filters.minMC > 0) {
      const mc = parseValue(token.marketCap);
      if (mc < filters.minMC) {
        reasons.push(`MC ${token.marketCap} below min $${filters.minMC}`);
      }
    }

    // Transaction count filter
    if (filters.minTX !== undefined && filters.minTX > 0) {
      const tx = parseTxCount(token.transactions);
      if (tx < filters.minTX) {
        reasons.push(`TX ${token.transactions} below min ${filters.minTX}`);
      }
    }

    return {
      passed: reasons.length === 0,
      reasons
    };
  }

  /**
   * Format a timestamp for logging.
   */
  function formatTimestamp(date) {
    const d = date || new Date();
    return d.toLocaleTimeString('en-US', { hour12: false }) + '.' +
      String(d.getMilliseconds()).padStart(3, '0');
  }

  /**
   * Generate a unique key for a token (used for deduplication).
   */
  function tokenKey(token) {
    return token.tokenPath || token.ticker || '';
  }

  /**
   * Throttle a function to execute at most once every `delay` ms.
   */
  function throttle(fn, delay) {
    let lastCall = 0;
    let timer = null;
    return function (...args) {
      const now = Date.now();
      const remaining = delay - (now - lastCall);
      if (remaining <= 0) {
        lastCall = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          lastCall = Date.now();
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  }

  return {
    parseAge,
    parseValue,
    parseTxCount,
    matchesFilters,
    formatTimestamp,
    tokenKey,
    throttle
  };
})();

// Make available in both content script and service worker contexts
if (typeof globalThis !== 'undefined') {
  globalThis.MemeUtils = MemeUtils;
}
