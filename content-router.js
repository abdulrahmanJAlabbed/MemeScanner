/**
 * Zero-Flicker content router.
 *
 * DOM patching strategy:
 * - A MutationObserver only schedules scans; it does not parse synchronously.
 * - Parsing runs in requestAnimationFrame, which aligns reads with paint cadence.
 * - A fingerprint map diff (from content-script.js) sends only changed tokens,
 *   reducing message volume and avoiding layout jitter from noisy updates.
 */

(() => {
  'use strict';

  const TAG = '[MemeScanner Router]';
  const runtimeConfig = globalThis.MemeScannerContent?.getManifestScraperConfig?.() || {};
  const debounceMs = Number(runtimeConfig.debounceMs || 140);
  const pollMs = Math.max(1500, Number(runtimeConfig.refreshMs || runtimeConfig.updateIntervalMs || 700));

  let previousFingerprintMap = new Map();
  let observer = null;
  let rafId = 0;
  let hiddenScanTimer = 0;
  let debounceTimer = 0;
  let hasLoggedAttach = false;
  let hasLoggedFirstRows = false;
  let lastBatchStatusAt = 0;
  let lastZeroRowsStatusAt = 0;
  let pollingTimer = 0;
  let pendingFullScan = false;
  const pendingRows = new Set();
  const rowTokenMap = new Map();

  if (!globalThis.MemeScannerContent) {
    return;
  }

  const preset = globalThis.MemeScannerContent.getPresetForHost(window.location.hostname);
  if (!preset) {
    return;
  }

  bootstrap();

  function bootstrap() {
    sendStatus(`Router initialized for host ${window.location.hostname}`, { preset: preset.name });
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    attachObserver();
    pollingTimer = window.setInterval(() => scheduleScan({ full: true }), pollMs);
    scheduleScan({ full: true });
  }

  function onRuntimeMessage(message) {
    if (message?.type !== 'FORCE_SCAN') {
      return;
    }
    scheduleScan({ full: true });
    sendStatus('Forced scan request received.');
  }

  function attachObserver() {
    const root = findRootNode();
    if (!root) {
      sendStatus('Waiting for list container...');
      window.setTimeout(attachObserver, 800);
      return;
    }

    if (!hasLoggedAttach) {
      hasLoggedAttach = true;
      sendStatus('Observer attached to token list container.');
    }

    observer = new MutationObserver((mutations) => {
      const updatedRows = collectUpdatedRows(mutations);
      if (!updatedRows.length) {
        return;
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = window.setTimeout(() => {
        scheduleScan({ rows: updatedRows });
      }, debounceMs);
    });

    observer.observe(root, {
      childList: false,
      subtree: true,
      characterData: true,
      attributes: false
    });
  }

  function scheduleScan(options = {}) {
    const rows = Array.isArray(options.rows) ? options.rows : [];
    if (options.full) {
      pendingFullScan = true;
    }
    rows.forEach((row) => {
      if (row) {
        pendingRows.add(row);
      }
    });

    if (document.visibilityState !== 'visible') {
      if (hiddenScanTimer) {
        clearTimeout(hiddenScanTimer);
      }
      hiddenScanTimer = window.setTimeout(() => {
        hiddenScanTimer = 0;
        runScan();
      }, 60);
      return;
    }

    if (hiddenScanTimer) {
      clearTimeout(hiddenScanTimer);
      hiddenScanTimer = 0;
    }

    if (rafId) {
      cancelAnimationFrame(rafId);
    }

    rafId = requestAnimationFrame(() => {
      rafId = 0;
      runScan();
    });
  }

  function runScan() {
    const root = findRootNode();
    if (!root) {
      return;
    }

    const shouldRunFullScan = pendingFullScan || pendingRows.size === 0;
    const rowsToScan = shouldRunFullScan ? [] : Array.from(pendingRows);
    pendingFullScan = false;
    pendingRows.clear();

    const extracted = shouldRunFullScan
      ? globalThis.MemeScannerContent.safeExtractTokens(root, preset)
      : globalThis.MemeScannerContent.safeExtractTokensFromRows(rowsToScan, preset);
    const patch = globalThis.MemeScannerContent.patchChangedTokens(previousFingerprintMap, extracted, {
      skipRemoval: !shouldRunFullScan
    });
    const replacedTokenIds = shouldRunFullScan ? [] : collectReplacedTokenIds(extracted);
    const removedTokenIds = dedupeIds([...(patch.removed || []), ...replacedTokenIds]);

    previousFingerprintMap = patch.nextMap;
    if (shouldRunFullScan) {
      rebuildRowTokenMap(extracted);
    }

    if (!extracted.length) {
      const now = Date.now();
      if (now - lastZeroRowsStatusAt > 5000) {
        lastZeroRowsStatusAt = now;
        sendStatus('Scan ran but found 0 rows.', {
          selector: preset.row || 'div[data-index]',
          container: preset.listContainer || "section[aria-label='Table content']",
          url: window.location.href
        });
      }
    } else if (!hasLoggedFirstRows) {
      hasLoggedFirstRows = true;
      sendStatus(`Detected ${extracted.length} rows from ${preset.name}.`);
    }

    if (!patch.changed.length && !removedTokenIds.length) {
      return;
    }

    safeRuntimeSendMessage(
      {
        type: 'MARKET_BATCH',
        payload: {
          source: preset.name,
          scannedAt: Date.now(),
          tokens: patch.changed,
          removedTokenIds
        }
      },
      () => {
        if (chrome.runtime.lastError) {
          console.debug(`${TAG} worker unavailable`, chrome.runtime.lastError.message);
          return;
        }

        const now = Date.now();
        if (now - lastBatchStatusAt > 4000) {
          lastBatchStatusAt = now;
          sendStatus(
            `Sent ${patch.changed.length} changed / ${removedTokenIds.length} removed tokens (${extracted.length} scanned).`
          );
        }
      }
    );
  }

  function collectUpdatedRows(mutations) {
    const rows = new Set();
    for (const mutation of mutations) {
      const row = findRowNode(mutation.target);
      if (row) {
        rows.add(row);
      }
    }
    return Array.from(rows);
  }

  function findRowNode(node) {
    if (!node) {
      return null;
    }
    if (node instanceof Element) {
      return node.closest(preset.row || 'div[data-index]');
    }
    const parent = node.parentElement;
    return parent ? parent.closest(preset.row || 'div[data-index]') : null;
  }

  function collectReplacedTokenIds(tokens) {
    const removed = [];
    for (const token of tokens) {
      const order = Number(token?.pageOrder);
      const tokenId = token?.tokenId;
      if (!Number.isFinite(order) || !tokenId) {
        continue;
      }
      const prevTokenId = rowTokenMap.get(order);
      if (prevTokenId && prevTokenId !== tokenId) {
        removed.push(prevTokenId);
      }
      rowTokenMap.set(order, tokenId);
    }
    return removed;
  }

  function rebuildRowTokenMap(tokens) {
    rowTokenMap.clear();
    for (const token of tokens) {
      const order = Number(token?.pageOrder);
      const tokenId = token?.tokenId;
      if (!Number.isFinite(order) || !tokenId) {
        continue;
      }
      rowTokenMap.set(order, tokenId);
    }
  }

  function dedupeIds(ids) {
    return Array.from(new Set((ids || []).filter(Boolean)));
  }

  function safeRuntimeSendMessage(message, callback) {
    try {
      if (!chrome?.runtime?.id) {
        return false;
      }
      chrome.runtime.sendMessage(message, callback);
      return true;
    } catch (error) {
      console.debug(`${TAG} runtime messaging failed`, error?.message || error);
      return false;
    }
  }

  function findRootNode() {
    const selector = preset.listContainer || "section[aria-label='Table content']";
    const candidates = Array.from(document.querySelectorAll(selector));

    if (!candidates.length) {
      return document.body;
    }

    const scored = candidates
      .map((node) => {
        const rowCount = node.querySelectorAll(preset.row || 'div[data-index]').length;
        const visible = node.offsetParent !== null || getComputedStyle(node).display !== 'none';
        return { node, rowCount, visible };
      })
      .sort((a, b) => {
        if (a.rowCount !== b.rowCount) {
          return b.rowCount - a.rowCount;
        }
        return Number(b.visible) - Number(a.visible);
      });

    return scored[0]?.node || document.body;
  }

  function sendStatus(message, meta = undefined) {
    safeRuntimeSendMessage(
      {
        type: 'CONTENT_STATUS',
        payload: {
          message,
          meta,
          at: Date.now()
        }
      },
      () => {
        if (chrome.runtime.lastError) {
          return;
        }
      }
    );
  }

  window.addEventListener('beforeunload', () => {
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = 0;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = 0;
    }
    if (hiddenScanTimer) {
      clearTimeout(hiddenScanTimer);
      hiddenScanTimer = 0;
    }
  });
})();
