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
  const pollMs = Math.max(300, Number(runtimeConfig.refreshMs || runtimeConfig.updateIntervalMs || 700));

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
    pollingTimer = window.setInterval(scheduleScan, pollMs);
    scheduleScan();
  }

  function onRuntimeMessage(message) {
    if (message?.type !== 'FORCE_SCAN') {
      return;
    }
    scheduleScan();
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
      const shouldSchedule = mutations.some((mutation) => {
        return mutation.type === 'childList' || mutation.type === 'characterData' || mutation.type === 'attributes';
      });

      if (!shouldSchedule) {
        return;
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = window.setTimeout(() => {
        scheduleScan();
      }, debounceMs);
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
  }

  function scheduleScan() {
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

    const extracted = globalThis.MemeScannerContent.safeExtractTokens(root, preset);
    const patch = globalThis.MemeScannerContent.patchChangedTokens(previousFingerprintMap, extracted);
    previousFingerprintMap = patch.nextMap;

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

    if (!patch.changed.length && !patch.removed.length) {
      return;
    }

    safeRuntimeSendMessage(
      {
        type: 'MARKET_BATCH',
        payload: {
          source: preset.name,
          scannedAt: Date.now(),
          tokens: patch.changed,
          removedTokenIds: patch.removed
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
            `Sent ${patch.changed.length} changed / ${patch.removed.length} removed tokens (${extracted.length} scanned).`
          );
        }
      }
    );
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
