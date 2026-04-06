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

  // ───────────────────────────────────────────────────────────────
  //  ADVANCED FILTER ENGINE — 4 Battle-Tested Plans (April 2026)
  //  Works PURELY from DOM-scraped fields. No API/CLI needed.
  // ───────────────────────────────────────────────────────────────

  const FILTER_PLANS = {
    conservative: {
      name: 'Conservative',
      devMax: 3,
      insiderMax: 5,
      bundleMax: 1,
      sniperMax: 8,
      ratMax: 10,
      combinedRiskMax: 8,
      topHoldersMax: 25,
      holdersMin: 250,
      smartMoneyMin: 4,
      buyRatioMin: 65,
      mcapMax: 120000,
      ageMaxSeconds: 480,   // 8 minutes
      velocityMin: 0,
      minScore: 90
    },
    balanced: {
      name: 'Balanced',
      devMax: 5,
      insiderMax: 8,
      bundleMax: 5,
      sniperMax: 10,
      ratMax: 15,
      combinedRiskMax: 12,
      topHoldersMax: 32,
      holdersMin: 180,
      smartMoneyMin: 3,
      buyRatioMin: 60,
      mcapMax: 150000,
      ageMaxSeconds: 600,   // 10 minutes
      velocityMin: 0,
      minScore: 75
    },
    aggressive: {
      name: 'Aggressive',
      devMax: 7,
      insiderMax: 10,
      bundleMax: 8,
      sniperMax: 15,
      ratMax: 20,
      combinedRiskMax: 15,
      topHoldersMax: 38,
      holdersMin: 120,
      smartMoneyMin: 2,
      buyRatioMin: 55,
      mcapMax: 80000,
      ageMaxSeconds: 360,   // 6 minutes
      velocityMin: 0,
      minScore: 65
    },
    hybrid: {
      name: 'Hybrid',
      devMax: 5,
      insiderMax: 8,
      bundleMax: 5,
      sniperMax: 10,
      ratMax: 15,
      combinedRiskMax: 12,
      topHoldersMax: 32,
      holdersMin: 180,
      smartMoneyMin: 3,
      buyRatioMin: 60,
      mcapMax: 150000,
      ageMaxSeconds: 600,
      velocityMin: 0,
      minScore: 70
    }
  };

  /**
   * Parse a scraped string value into a usable number.
   * Handles: "9%", "$1.8K", "44m", "0.5%", "+$21K", "3", "0", "", etc.
   */
  function toNum(val) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (!val) return 0;
    const s = String(val).trim();

    // Pure number
    const directNum = Number(s);
    if (Number.isFinite(directNum)) return directNum;

    // Percentage: "9%", "0.5%"
    const pctMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
    if (pctMatch) return parseFloat(pctMatch[1]);

    // Dollar + suffix: "$1.8K", "+$21K", "-$500"
    return parseValue(s);
  }

  /**
   * Evaluate a single token against one of the 4 filter plans.
   * Returns a full decision object with every check logged.
   *
   * ALL data comes from the extension's DOM scraping — zero API/CLI calls.
   */
  function evaluateToken(token, selectedPlan) {
    const planKey = selectedPlan || 'balanced';
    const plan = FILTER_PLANS[planKey] || FILTER_PLANS.balanced;
    const checks = {};
    let score = 100;

    // ── Parse scraped strings into numbers ──
    const devPct = toNum(token.devPct || token.devSoldPct);
    const insider = toNum(token.insiderPct);
    const bundle = toNum(token.bundlePct || token.bundlersPct);
    const sniper = toNum(token.sniperPct);
    const rat = toNum(token.ratPct);
    const topHolders = toNum(token.topHolders || token.top10Pct || token.topHoldersPct);
    const holders = toNum(token.holders);
    const smartMoney = toNum(token.smartMoney);
    const buyRatio = toNum(token.buyRatio);
    const mcap = toNum(token.marketCap);
    const ageSec = typeof token.ageSeconds === 'number' ? token.ageSeconds : parseAge(token.age);
    const velocity = typeof token.velocityScore === 'number' ? token.velocityScore : 0;
    const netFlow = toNum(token.netFlow);
    const hasSocials = !!(token.socialLink || token.twitterHandle || token.websiteLink);
    const twitterFollowers = toNum(token.twitterFollowers);

    // ── 1. Dev & Risk checks ──
    const combinedRisk = insider + bundle + sniper + rat;

    checks.dev = {
      passed: devPct <= plan.devMax,
      value: devPct,
      threshold: plan.devMax,
      label: 'Dev Holding %'
    };
    checks.insider = {
      passed: insider <= plan.insiderMax,
      value: insider,
      threshold: plan.insiderMax,
      label: 'Insider %'
    };
    checks.bundle = {
      passed: bundle <= plan.bundleMax,
      value: bundle,
      threshold: plan.bundleMax,
      label: 'Bundle %'
    };
    checks.sniper = {
      passed: sniper <= plan.sniperMax,
      value: sniper,
      threshold: plan.sniperMax,
      label: 'Sniper %'
    };
    checks.rat = {
      passed: rat <= plan.ratMax,
      value: rat,
      threshold: plan.ratMax,
      label: 'Rat %'
    };
    checks.combinedRisk = {
      passed: combinedRisk <= plan.combinedRiskMax,
      value: combinedRisk,
      threshold: plan.combinedRiskMax,
      label: 'Combined Risk (insider+bundle+sniper+rat)'
    };

    // ── 2. Holder concentration ──
    checks.topHolders = {
      passed: topHolders <= plan.topHoldersMax,
      value: topHolders,
      threshold: plan.topHoldersMax,
      label: 'Top Holders %'
    };

    // ── 3. Momentum & Social signals ──
    checks.holders = {
      passed: holders >= plan.holdersMin,
      value: holders,
      threshold: plan.holdersMin,
      label: 'Holder Count'
    };
    checks.smartMoney = {
      passed: smartMoney >= plan.smartMoneyMin,
      value: smartMoney,
      threshold: plan.smartMoneyMin,
      label: 'Smart Money'
    };
    checks.buyRatio = {
      passed: buyRatio >= plan.buyRatioMin,
      value: buyRatio,
      threshold: plan.buyRatioMin,
      label: 'Buy Ratio %'
    };
    checks.velocity = {
      passed: velocity > plan.velocityMin,
      value: Number(velocity.toFixed(4)),
      threshold: plan.velocityMin,
      label: 'Velocity Score'
    };

    // ── 4. Stage checks ──
    checks.age = {
      passed: Number.isFinite(ageSec) && ageSec <= plan.ageMaxSeconds,
      value: ageSec,
      threshold: plan.ageMaxSeconds,
      label: 'Age (seconds)'
    };
    checks.mcap = {
      passed: mcap > 0 && mcap <= plan.mcapMax,
      value: mcap,
      threshold: plan.mcapMax,
      label: 'Market Cap ($)'
    };
    checks.netFlow = {
      passed: netFlow > 0,
      value: netFlow,
      threshold: 0,
      label: 'Net Flow ($)'
    };

    // ── 5. Social bonus (not a hard fail, but adds/removes score) ──
    checks.socials = {
      passed: hasSocials,
      value: hasSocials ? (token.twitterHandle || 'yes') : 'none',
      threshold: 'any',
      label: 'Social Links'
    };

    // ── Calculate score ──
    // Critical checks that MUST pass for any approval:
    const criticalKeys = ['dev', 'combinedRisk', 'topHolders', 'age', 'mcap'];
    const momentumKeys = ['holders', 'smartMoney', 'buyRatio', 'velocity', 'netFlow'];
    const bonusKeys = ['socials'];

    let criticalFails = 0;
    let momentumFails = 0;

    for (const key of criticalKeys) {
      if (!checks[key].passed) {
        score -= 15;
        criticalFails++;
      }
    }
    for (const key of momentumKeys) {
      if (!checks[key].passed) {
        score -= 8;
        momentumFails++;
      }
    }
    for (const key of bonusKeys) {
      if (checks[key].passed) score += 3;
      // No penalty for missing socials
    }

    score = Math.max(0, Math.min(100, score));

    // ── Collect risk flags ──
    const riskFlags = [];
    for (const [key, check] of Object.entries(checks)) {
      if (!check.passed && key !== 'socials') {
        riskFlags.push(`${check.label}: ${check.value} (limit: ${check.threshold})`);
      }
    }

    // ── Decision ──
    const passesRules = score >= plan.minScore && criticalFails === 0;

    let action = 'skip';
    let suggestedSol = 0;
    if (passesRules) {
      if (score >= 90) { action = 'buy_medium'; suggestedSol = 0.05; }
      else if (score >= 75) { action = 'buy_small'; suggestedSol = 0.03; }
      else { action = 'watch'; suggestedSol = 0; }
    }

    return {
      token_ca: token.contractAddress || token.tokenId || '',
      ticker: token.ticker || '',
      plan_used: plan.name,
      passes_rules: passesRules,
      score_0_to_100: Math.round(score),
      recommended_action: action,
      suggested_buy_sol: suggestedSol,
      critical_fails: criticalFails,
      momentum_fails: momentumFails,
      individual_checks: checks,
      risk_flags: riskFlags,
      reasoning: `${plan.name} plan – ${passesRules ? 'PASS' : 'FAIL'} | Score ${Math.round(score)}/100 | ${criticalFails} critical fails, ${momentumFails} momentum fails | ${riskFlags.length} red flags`,
      timestamp: Date.now(),
      raw_token: {
        ticker: token.ticker,
        name: token.name,
        contractAddress: token.contractAddress,
        age: token.age,
        marketCap: token.marketCap,
        volume: token.volume,
        netFlow: token.netFlow,
        holders: token.holders,
        smartMoney: token.smartMoney,
        buyRatio: token.buyRatio,
        devPct: token.devPct,
        bundlePct: token.bundlePct,
        insiderPct: token.insiderPct,
        ratPct: token.ratPct,
        sniperPct: token.sniperPct,
        topHolders: token.topHolders,
        twitterHandle: token.twitterHandle,
        twitterFollowers: token.twitterFollowers,
        velocityScore: token.velocityScore,
        platform: token.platform
      }
    };
  }

  return {
    SELECTORS,
    safeQuery,
    parseAge,
    parseValue,
    parsePercent,
    matchesFilters,
    formatTimestamp,
    FILTER_PLANS,
    evaluateToken,
    toNum
  };
})();

// Bridge for SW and CS
if (typeof globalThis !== 'undefined') globalThis.MemeUtils = MemeUtils;
if (typeof module !== 'undefined') module.exports = MemeUtils;
