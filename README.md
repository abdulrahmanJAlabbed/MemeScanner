# MemeScanner Pro

MemeScanner Pro is a premium Solana token scanner Chrome extension with a Manifest V3 architecture, zero-flicker content ingestion, and live portfolio simulation.

## Core Highlights

- Manifest V3 service-worker backend using event-driven `chrome.runtime.onMessage`.
- Persistent state via `chrome.storage.local` for watchlist, positions, HUD metrics, market feed, and logs.
- Obsidian popup UI with neon Solana accents, custom dark inputs, and persistent HUD hierarchy.
- Zero-flicker content pipeline using debounced `MutationObserver` + `requestAnimationFrame` + diff-only token updates.
- Configurable scraper presets in `scraper-config.json`, loaded by `content-script.js` at runtime.

## Project Structure

```text
MemeScanner/
├── assets/
│   └── logos/
├── icons/
├── manifest.json        # MV3 config and permissions
├── scraper-config.json  # Dynamic scraper presets and parser tuning
├── background.js        # Stateless service worker + storage-backed simulation logic
├── content-script.js    # Extraction + audit-suite parser helpers
├── content-router.js    # Zero-flicker observer and diff routing bridge
├── content-style.css    # Isolated content-script style scope
├── popup.html
├── popup.css
├── popup.js             # Dashboard rendering and controls
└── utils.js             # Shared parsing/filtering utilities
```

## Installation

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this workspace folder.
5. Pin the extension.

## Verification Checklist

1. **MV3 wiring**
	- In `chrome://extensions`, open extension details and verify background is a service worker.
	- Open service worker console and confirm no startup/runtime errors.

2. **Live feed stability (Zero-Flicker Engine)**
	- Open a supported DEX page (for example Axiom discover view).
	- Keep the page active while rows update rapidly.
	- Confirm popup `Feed` updates without visible jitter/reflow bursts.
	- Confirm `SCANNED`, `MATCHED`, and `REJECTED` counters continue updating.

3. **Simulation P&L behavior**
	- In popup `Feed`, click `Buy` for at least one token.
	- Move to `Portfolio` and confirm entry value is created.
	- Wait for market updates and verify `P&L (Live)` changes.
	- Click `Sell` and confirm position is removed.

4. **Persistence across restarts**
	- Add tokens to watchlist and open one or more simulated positions.
	- Close and reopen browser, then reopen extension popup.
	- Verify watchlist, positions, and HUD counters persist.

5. **Settings application**
	- Change filter ranges/keywords in `Settings` and click `Apply Settings`.
	- Confirm scanner behavior changes on incoming tokens.
	- Confirm updated settings remain after reopening the popup.
