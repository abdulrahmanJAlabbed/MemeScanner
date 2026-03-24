const {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    SYSVAR_RENT_PUBKEY,
    SystemProgram,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction
} = require('@solana/web3.js');
const {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAssociatedTokenAddress,
    getMint,
    unpackAccount
} = require('@solana/spl-token');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const ANSI = {
    clearScreen: '\x1b[2J',
    cursorHome: '\x1b[H',
    clearDown: '\x1b[J',
    hideCursor: '\x1b[?25l',
    showCursor: '\x1b[?25h',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m'
};

const STAKED_RPC_HTTP_URL = process.env.STAKED_RPC_HTTP_URL || process.env.HTTP_URL || 'https://mainnet.helius-rpc.com/?api-key=bd671ad8-382f-41fd-9d68-28ee7e46872b';
const STAKED_RPC_WS_URL = process.env.STAKED_RPC_WS_URL || process.env.WS_URL || 'wss://mainnet.helius-rpc.com/?api-key=bd671ad8-382f-41fd-9d68-28ee7e46872b';
const COMMITMENT = process.env.COMMITMENT || 'processed';

const IPC_HOST = process.env.IPC_HOST || '127.0.0.1';
const IPC_PORT = Number(process.env.IPC_PORT || 8080);
const IPC_AUTH_TOKEN = process.env.IPC_AUTH_TOKEN || 'local-dev-ipc-token';

const EXECUTION_ENABLED = process.env.EXECUTION_ENABLED === '1';
const WALLET_SECRET_KEY = process.env.WALLET_SECRET_KEY || '';

const RPC_WATCHDOG_MS = Number(process.env.RPC_WATCHDOG_MS || 8000);
const RPC_STALE_MS = Number(process.env.RPC_STALE_MS || 45000);
const RECONNECT_BASE_MS = Number(process.env.RECONNECT_BASE_MS || 1000);
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS || 30000);
const RECONNECT_JITTER_MS = Number(process.env.RECONNECT_JITTER_MS || 600);

const IDEMPOTENCY_WINDOW_MS = Number(process.env.IDEMPOTENCY_WINDOW_MS || 1500);
const IDEMPOTENCY_KEY_TTL_MS = Number(process.env.IDEMPOTENCY_KEY_TTL_MS || 60000);

const MAX_TOP10_PCT = Number(process.env.MAX_TOP10_PCT || 25);
const MAX_BUNDLERS_PCT = Number(process.env.MAX_BUNDLERS_PCT || 20);
const MAX_DEV_PCT = Number(process.env.MAX_DEV_PCT || 8);
const REQUIRE_LP_BURN = process.env.REQUIRE_LP_BURN !== '0';
const MIN_BUY_VELOCITY = Number(process.env.MIN_BUY_VELOCITY || 0.02);
const VELOCITY_WINDOW_MS = Number(process.env.VELOCITY_WINDOW_MS || 15000);
const TRAILING_STOP_DRAWDOWN = Number(process.env.TRAILING_STOP_DRAWDOWN || 0.15);
const OPEN_STALE_EXIT_MS = Number(process.env.OPEN_STALE_EXIT_MS || 45000);
const LOCKED_PROFIT_TRIGGER_PCT = Number(process.env.LOCKED_PROFIT_TRIGGER_PCT || 3.0);
const LOCKED_PROFIT_FLOOR_PCT = Number(process.env.LOCKED_PROFIT_FLOOR_PCT || 0.25);
const STRICT_SLIPPAGE_BPS = Number(process.env.STRICT_SLIPPAGE_BPS || 50);
const SOL_PRICE_USD = Number(process.env.SOL_PRICE_USD || 150);
const MAX_OPEN_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS || 2);
const INITIAL_CAPITAL_USD = Number(process.env.INITIAL_CAPITAL_USD || 200);
const POSITION_SIZE_PCT = Number(process.env.POSITION_SIZE_PCT || 15) / 100;
const MAX_POSITION_USD = Number(process.env.MAX_POSITION_USD || 100);
const MIN_POSITION_USD = Number(process.env.MIN_POSITION_USD || 5);
const MAX_ACTIVE_TARGETS = Number(process.env.MAX_ACTIVE_TARGETS || 12);
const SMART_TARGET_GATING = process.env.SMART_TARGET_GATING !== '0';
const SKIP_EMIT_COOLDOWN_MS = Number(process.env.SKIP_EMIT_COOLDOWN_MS || 5000);
const TARGET_REJECT_DEDUP_MS = Number(process.env.TARGET_REJECT_DEDUP_MS || 5000);
const TARGET_EVICT_MIN_AGE_MS = Number(process.env.TARGET_EVICT_MIN_AGE_MS || 30000);
const TARGET_IDLE_PRUNE_MS = Number(process.env.TARGET_IDLE_PRUNE_MS || 180000);
const TARGET_DEFERRED_EMIT_MS = Number(process.env.TARGET_DEFERRED_EMIT_MS || 5000);

const DYNAMIC_FEE_WINDOW = Number(process.env.DYNAMIC_FEE_WINDOW || 150);
const BASE_CONTENTION_MULTIPLIER = Number(process.env.BASE_CONTENTION_MULTIPLIER || 1.35);
const CONTENTION_MULTIPLIER_CAP = Number(process.env.CONTENTION_MULTIPLIER_CAP || 6.0);

const PUMP_PROGRAM_ID = process.env.PUMP_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfX9PNXbHWeuR6dPump';
const PUMP_EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjENu3Ecx6eA1T5s9QvY5k8Zg';
const PUMP_GLOBAL = '4wTV1YmiEkRvAtNtsSNG1vWHZzmZeKn1yXoF99Kq7zME';
const PUMP_FEE_RECIPIENT = 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM';
const PUMP_BUY_DISCRIMINATOR = process.env.PUMP_BUY_DISCRIMINATOR || '';
const PUMP_SELL_DISCRIMINATOR = process.env.PUMP_SELL_DISCRIMINATOR || '';

const DEFAULT_SELL_AMOUNT_RAW = BigInt(process.env.SELL_AMOUNT_RAW || 1000000);

const BOOTSTRAP_TARGET_MINT = process.env.TARGET_TOKEN_MINT || '';
const BOOTSTRAP_MODE = process.env.BOOTSTRAP_MODE || 'paper';
const CLI_PRETTY = process.env.CLI_PRETTY !== '0' && process.stdout.isTTY;
const CLI_JSON = process.env.CLI_JSON === '1';
const CLI_ANIMATED = process.env.CLI_ANIMATED !== '0' && CLI_PRETTY && !CLI_JSON;
const CLI_REFRESH_MS = Number(process.env.CLI_REFRESH_MS || 220);
const CLI_TICK_SUMMARY_MS = Number(process.env.CLI_TICK_SUMMARY_MS || 1800);
const CLI_ERROR_DEDUP_MS = Number(process.env.CLI_ERROR_DEDUP_MS || 5000);
const SESSION_LOGS_ENABLED = process.env.SESSION_LOGS !== '0';
const SESSION_LOG_DIR = process.env.SESSION_LOG_DIR || path.join(process.cwd(), 'logs', 'sessions');

const orchestrator = {
    connection: null,
    wallet: null,
    positions: new Map(),
    pendingTargetInitializations: new Set(),
    deferredTarget: null,
    deferredTargetNoticeAt: 0,
    targetRejectionSeenAt: new Map(),
    pendingMetadata: new Map(),
    ipcClients: new Set(),
    reconnecting: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    wsHooked: false,
    watchdogHandle: null
};

const cliState = {
    startedAt: Date.now(),
    spinnerIndex: 0,
    rendererTimer: null,
    rendererActive: false,
    lastRenderAt: 0,
    eventCounts: new Map(),
    lastTick: null,
    lastTicksByMint: new Map(),
    lastTickSummaryAt: 0,
    toxicityErrorSeenAt: new Map(),
    recentImportant: [],
    lastIpcError: '',
    lastIpcErrorAt: 0,
    realizedPnlUsd: 0,
    closedTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    breakEvenTrades: 0,
    deployedUsd: 0,
    peakActiveTargets: 0,
    peakOpenPositions: 0,
    skipReasons: new Map()
};

const capitalState = {
    initialUsd: Number.isFinite(INITIAL_CAPITAL_USD) && INITIAL_CAPITAL_USD > 0 ? INITIAL_CAPITAL_USD : 200,
    availableUsd: Number.isFinite(INITIAL_CAPITAL_USD) && INITIAL_CAPITAL_USD > 0 ? INITIAL_CAPITAL_USD : 200,
    lockedUsd: 0
};

const sessionState = {
    startedAtIso: new Date().toISOString(),
    endedAtIso: null,
    sessionId: new Date().toISOString().replace(/[:.]/g, '-'),
    initialized: false,
    summaryWritten: false,
    rawEventsPath: '',
    summaryPath: '',
    stream: null,
    totalEvents: 0,
    eventTypeCounts: new Map(),
    stderrLines: 0,
    lastError: ''
};

function status(message) {
    appendSessionLog({
        kind: 'status',
        ts: new Date().toISOString(),
        sessionId: sessionState.sessionId,
        message: String(message || '')
    });

    if (CLI_ANIMATED) {
        pushRecentImportant(`[${eventTime(new Date().toISOString())}] ${String(message || '')}`);
        return;
    }
    process.stderr.write(`${message}\n`);
}

const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, cb) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString(encoding || 'utf8') : String(chunk || '');
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned) {
        sessionState.stderrLines += 1;
        appendSessionLog({
            kind: 'stderr',
            ts: new Date().toISOString(),
            sessionId: sessionState.sessionId,
            message: cleaned
        });
    }

    if (!CLI_ANIMATED) {
        return originalStderrWrite(chunk, encoding, cb);
    }

    if (!cleaned) {
        return true;
    }

    if (cleaned.includes('429 Too Many Requests')) {
        const ts = eventTime(new Date().toISOString());
        pushRecentImportant(`[${ts}] rpc 429 rate-limited (auto-retry)`);
        const prev = cliState.eventCounts.get('rpc_429') || 0;
        cliState.eventCounts.set('rpc_429', prev + 1);
        if (typeof cb === 'function') cb();
        return true;
    }

    // Route non-fatal stderr noise into the activity feed while dashboard is active.
    pushRecentImportant(`[${eventTime(new Date().toISOString())}] ${trimLine(cleaned, 120)}`);
    if (typeof cb === 'function') cb();
    return true;
};

function shortMint(value) {
    const mint = String(value || '');
    if (!mint) return '-';
    if (mint.length <= 12) return mint;
    return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function eventTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toISOString().slice(11, 19);
}

function pushRecentImportant(line) {
    const clean = String(line || '');
    const last = cliState.recentImportant[cliState.recentImportant.length - 1];
    if (last) {
        const match = last.match(/^(.*) \(x(\d+)\)$/);
        const base = match ? match[1] : last;
        const repeat = match ? Number(match[2]) : 1;
        if (base === clean) {
            cliState.recentImportant[cliState.recentImportant.length - 1] = `${base} (x${repeat + 1})`;
            return;
        }
    }

    cliState.recentImportant.push(line);
    if (cliState.recentImportant.length > 12) {
        cliState.recentImportant.shift();
    }
}

function toMapObject(map) {
    return Object.fromEntries(Array.from(map.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function ensureSessionLogging() {
    if (!SESSION_LOGS_ENABLED || sessionState.initialized) return;

    fs.mkdirSync(SESSION_LOG_DIR, { recursive: true });
    sessionState.rawEventsPath = path.join(SESSION_LOG_DIR, `${sessionState.sessionId}.events.jsonl`);
    sessionState.summaryPath = path.join(SESSION_LOG_DIR, `${sessionState.sessionId}.summary.json`);
    sessionState.stream = fs.createWriteStream(sessionState.rawEventsPath, { flags: 'a' });
    sessionState.initialized = true;

    const bootstrap = {
        kind: 'session_start',
        ts: new Date().toISOString(),
        sessionId: sessionState.sessionId,
        cwd: process.cwd(),
        rpcHttp: STAKED_RPC_HTTP_URL,
        rpcWs: STAKED_RPC_WS_URL,
        executionEnabled: EXECUTION_ENABLED,
        strategy: {
            minBuyVelocity: MIN_BUY_VELOCITY,
            trailingStopDrawdown: TRAILING_STOP_DRAWDOWN,
            openStaleExitMs: OPEN_STALE_EXIT_MS,
            lockedProfitTriggerPct: LOCKED_PROFIT_TRIGGER_PCT,
            lockedProfitFloorPct: LOCKED_PROFIT_FLOOR_PCT,
            maxTop10Pct: MAX_TOP10_PCT,
            maxBundlersPct: MAX_BUNDLERS_PCT,
            maxDevPct: MAX_DEV_PCT,
            requireLpBurn: REQUIRE_LP_BURN,
            maxOpenPositions: MAX_OPEN_POSITIONS
        },
        sizing: {
            positionSizePct: Number((Math.max(0, POSITION_SIZE_PCT) * 100).toFixed(4)),
            maxPositionUsd: MAX_POSITION_USD,
            minPositionUsd: MIN_POSITION_USD,
            maxActiveTargets: MAX_ACTIVE_TARGETS,
            smartTargetGating: SMART_TARGET_GATING
        },
        capital: {
            initialUsd: capitalState.initialUsd
        }
    };
    sessionState.stream.write(`${JSON.stringify(bootstrap)}\n`);
}

function appendSessionLog(record) {
    if (!SESSION_LOGS_ENABLED) return;
    ensureSessionLogging();
    if (!sessionState.stream) return;
    try {
        sessionState.stream.write(`${JSON.stringify(record)}\n`);
    } catch {}
}

function recordSessionEvent(type, payload) {
    sessionState.totalEvents += 1;
    const prev = sessionState.eventTypeCounts.get(type) || 0;
    sessionState.eventTypeCounts.set(type, prev + 1);

    cliState.peakActiveTargets = Math.max(cliState.peakActiveTargets, orchestrator.positions.size);
    cliState.peakOpenPositions = Math.max(cliState.peakOpenPositions, getOpenPositionsCount());

    if (type === 'paper_entry') {
        const usd = Number(payload.amountUsd || 0);
        if (Number.isFinite(usd) && usd > 0) {
            cliState.deployedUsd += usd;
        }
    }

    if (type === 'paper_trade_result') {
        const pnlUsd = Number(payload.netPnlUsd || 0);
        cliState.realizedPnlUsd += Number.isFinite(pnlUsd) ? pnlUsd : 0;
        cliState.closedTrades += 1;
        if (pnlUsd > 0) cliState.winningTrades += 1;
        else if (pnlUsd < 0) cliState.losingTrades += 1;
        else cliState.breakEvenTrades += 1;
    }

    if (type === 'trade_skipped') {
        const reason = String(payload.reason || 'unknown');
        const count = cliState.skipReasons.get(reason) || 0;
        cliState.skipReasons.set(reason, count + 1);
    }

    if (type === 'ipc_error' || type === 'execution_error' || type === 'vault_error' || type === 'toxicity_error') {
        sessionState.lastError = String(payload.message || payload.reason || type);
    }

    appendSessionLog({
        kind: 'event',
        ts: payload.ts || new Date().toISOString(),
        sessionId: sessionState.sessionId,
        type,
        payload
    });
}

function finalizeSession(reason) {
    if (!SESSION_LOGS_ENABLED || sessionState.summaryWritten) return;
    ensureSessionLogging();

    sessionState.endedAtIso = new Date().toISOString();
    const summary = {
        sessionId: sessionState.sessionId,
        reason,
        startedAt: sessionState.startedAtIso,
        endedAt: sessionState.endedAtIso,
        uptimeSec: uptimeSec(),
        realizedPnlUsd: Number(cliState.realizedPnlUsd.toFixed(6)),
        deployedUsd: Number(cliState.deployedUsd.toFixed(6)),
        roiPct: cliState.deployedUsd > 0 ? Number(((cliState.realizedPnlUsd / cliState.deployedUsd) * 100).toFixed(4)) : 0,
        bankrollRoiPct: capitalState.initialUsd > 0 ? Number((((currentEquityUsd() - capitalState.initialUsd) / capitalState.initialUsd) * 100).toFixed(4)) : 0,
        closedTrades: cliState.closedTrades,
        winningTrades: cliState.winningTrades,
        losingTrades: cliState.losingTrades,
        breakEvenTrades: cliState.breakEvenTrades,
        winRatePct: cliState.closedTrades > 0 ? Number(((cliState.winningTrades / cliState.closedTrades) * 100).toFixed(2)) : 0,
        peakActiveTargets: cliState.peakActiveTargets,
        peakOpenPositions: cliState.peakOpenPositions,
        totalEvents: sessionState.totalEvents,
        stderrLines: sessionState.stderrLines,
        lastError: sessionState.lastError,
        eventTypeCounts: toMapObject(sessionState.eventTypeCounts),
        skipReasons: toMapObject(cliState.skipReasons),
        capital: {
            initialUsd: Number(capitalState.initialUsd.toFixed(6)),
            availableUsd: Number(capitalState.availableUsd.toFixed(6)),
            lockedUsd: Number(capitalState.lockedUsd.toFixed(6)),
            equityUsd: Number(currentEquityUsd().toFixed(6))
        },
        files: {
            eventsJsonl: sessionState.rawEventsPath,
            summaryJson: sessionState.summaryPath
        }
    };

    try {
        fs.writeFileSync(sessionState.summaryPath, JSON.stringify(summary, null, 2));
    } catch {}

    appendSessionLog({
        kind: 'session_end',
        ts: sessionState.endedAtIso,
        sessionId: sessionState.sessionId,
        reason,
        summary
    });

    if (sessionState.stream) {
        try {
            sessionState.stream.end();
        } catch {}
    }

    sessionState.summaryWritten = true;
}

function uptimeSec() {
    return Math.max(0, Math.floor((Date.now() - cliState.startedAt) / 1000));
}

function formatUptime(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isOpenPositionForMint(mint) {
    const p = orchestrator.positions.get(mint);
    return !!p?.isOpen;
}

function trimLine(text, maxLen) {
    const value = String(text || '');
    if (value.length <= maxLen) return value;
    return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

function roundUsd(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function currentEquityUsd() {
    return capitalState.availableUsd + capitalState.lockedUsd;
}

function computeEntryAmountUsd() {
    const pct = Number.isFinite(POSITION_SIZE_PCT) && POSITION_SIZE_PCT > 0 ? POSITION_SIZE_PCT : 0.15;
    const raw = capitalState.availableUsd * pct;
    const capped = Math.min(MAX_POSITION_USD, raw);
    return roundUsd(capped);
}

function canOpenByResources() {
    if (getOpenPositionsCount() >= MAX_OPEN_POSITIONS) {
        return { ok: false, reason: 'max_open_positions_reached' };
    }

    const planned = computeEntryAmountUsd();
    if (planned < MIN_POSITION_USD || capitalState.availableUsd < MIN_POSITION_USD) {
        return { ok: false, reason: 'insufficient_capital', plannedUsd: planned };
    }

    return { ok: true, plannedUsd: planned };
}

function isValidMintAddress(value) {
    try {
        if (!value) return false;
        new PublicKey(String(value));
        return true;
    } catch {
        return false;
    }
}

function totalReservedTargetSlots() {
    return orchestrator.positions.size + orchestrator.pendingTargetInitializations.size;
}

function selectEvictionCandidate() {
    const now = Date.now();
    let best = null;

    for (const position of orchestrator.positions.values()) {
        if (position.isOpen || position.isExecuting) {
            continue;
        }

        const lastSeen = position.lastSeenAt || position.lastVaultTickAt || position.createdAt || now;
        const ageMs = now - lastSeen;
        if (ageMs < TARGET_EVICT_MIN_AGE_MS) {
            continue;
        }

        if (!best || lastSeen < best.lastSeen) {
            best = { mint: position.mint, lastSeen };
        }
    }

    return best ? best.mint : null;
}

function emitTargetRejectedThrottled(payload) {
    const mint = String(payload?.mint || 'unknown');
    const reason = String(payload?.reason || 'unknown');
    const key = `${mint}:${reason}`;
    const now = Date.now();
    const lastAt = orchestrator.targetRejectionSeenAt.get(key) || 0;
    if (now - lastAt < TARGET_REJECT_DEDUP_MS) {
        return;
    }
    orchestrator.targetRejectionSeenAt.set(key, now);
    emit(payload);
}

function shouldAcceptNewTarget(mode) {
    if (!SMART_TARGET_GATING) {
        return { ok: true };
    }

    if (mode !== 'live') {
        const resources = canOpenByResources();
        if (!resources.ok) {
            return { ok: false, reason: resources.reason, plannedUsd: resources.plannedUsd };
        }
    }

    if (totalReservedTargetSlots() >= MAX_ACTIVE_TARGETS) {
        const evictMint = selectEvictionCandidate();
        if (evictMint) {
            return { ok: true, evictMint, evictReason: 'capacity_rebalance' };
        }
        return { ok: false, reason: 'max_active_targets_reached' };
    }

    return { ok: true };
}

function deferLatestTarget(target) {
    orchestrator.deferredTarget = {
        ...target,
        deferredAt: Date.now()
    };

    const now = Date.now();
    if (now - orchestrator.deferredTargetNoticeAt >= TARGET_DEFERRED_EMIT_MS) {
        orchestrator.deferredTargetNoticeAt = now;
        emit({
            type: 'target_deferred',
            ts: new Date().toISOString(),
            mint: target.mint,
            mode: target.mode,
            reason: 'max_open_positions_reached',
            activeTargets: orchestrator.positions.size,
            openPositions: getOpenPositionsCount(),
            maxOpenPositions: MAX_OPEN_POSITIONS
        });
    }
}

async function maybePromoteDeferredTarget() {
    const deferred = orchestrator.deferredTarget;
    if (!deferred) return;

    if (deferred.mode !== 'live' && getOpenPositionsCount() >= MAX_OPEN_POSITIONS) {
        return;
    }

    // Latest only: consume once, and if still blocked by resources, re-defer.
    orchestrator.deferredTarget = null;

    const mint = deferred.mint;
    const mode = deferred.mode || 'paper';
    if (!isValidMintAddress(mint)) {
        emitTargetRejectedThrottled({
            type: 'target_rejected',
            ts: new Date().toISOString(),
            mint,
            mode,
            reason: 'invalid_mint_format',
            activeTargets: orchestrator.positions.size,
            maxActiveTargets: MAX_ACTIVE_TARGETS
        });
        return;
    }

    if (orchestrator.positions.has(mint) || orchestrator.pendingTargetInitializations.has(mint)) {
        return;
    }

    const admission = shouldAcceptNewTarget(mode);
    if (!admission.ok) {
        if (admission.reason === 'max_open_positions_reached' || admission.reason === 'insufficient_capital') {
            deferLatestTarget(deferred);
            return;
        }

        emitTargetRejectedThrottled({
            type: 'target_rejected',
            ts: new Date().toISOString(),
            mint,
            mode,
            reason: admission.reason,
            activeTargets: totalReservedTargetSlots(),
            maxActiveTargets: MAX_ACTIVE_TARGETS,
            availableUsd: Number(capitalState.availableUsd.toFixed(2)),
            plannedUsd: Number((admission.plannedUsd || 0).toFixed(2))
        });
        return;
    }

    if (admission.evictMint && orchestrator.positions.has(admission.evictMint)) {
        const evicted = orchestrator.positions.get(admission.evictMint);
        if (evicted && !evicted.isOpen && !evicted.isExecuting) {
            await cleanupPosition(evicted, admission.evictReason || 'capacity_rebalance');
        }
    }

    orchestrator.pendingTargetInitializations.add(mint);
    try {
        await initializeTarget({
            mint,
            mode,
            amountUsd: deferred.amountUsd,
            metadata: deferred.metadata || {}
        });
    } finally {
        orchestrator.pendingTargetInitializations.delete(mint);
    }
}

async function pruneIdleFlatTargets() {
    if (orchestrator.positions.size === 0) return;
    const now = Date.now();
    const toPrune = [];

    for (const position of orchestrator.positions.values()) {
        if (position.isOpen || position.isExecuting) continue;
        const lastSeen = position.lastSeenAt || position.lastVaultTickAt || position.createdAt || now;
        if (now - lastSeen >= TARGET_IDLE_PRUNE_MS) {
            toPrune.push(position);
        }
        if (toPrune.length >= 2) break;
    }

    for (const position of toPrune) {
        await cleanupPosition(position, 'idle_prune');
    }
}

async function enforceOpenPositionSafety() {
    const now = Date.now();
    const openPositions = Array.from(orchestrator.positions.values()).filter((position) => position.isOpen);

    for (const position of openPositions) {
        if (position.isExecuting) {
            continue;
        }

        const stale = OPEN_STALE_EXIT_MS > 0 && position.lastVaultTickAt > 0 && now - position.lastVaultTickAt >= OPEN_STALE_EXIT_MS;
        if (!stale) {
            continue;
        }

        const source = 'watchdog:stale_open';
        const key = claimIdempotencyKey(position, 'sell', now, source);
        if (!key) {
            continue;
        }

        position.lastActionAt = now;
        const currentPriceScaled = computeVirtualPriceScaled(position, position.lastVaultAmount || 1n);
        const reason = 'stale_open_timeout';
        await closePosition(position, now, reason, currentPriceScaled);
    }
}

function canAllocateCapital(usdNeeded) {
    const amount = Number(usdNeeded || 0);
    if (!Number.isFinite(amount) || amount <= 0) return false;
    return capitalState.availableUsd >= amount;
}

function allocateCapital(usdAmount) {
    const amount = Number(usdAmount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (capitalState.availableUsd < amount) return false;
    capitalState.availableUsd -= amount;
    capitalState.lockedUsd += amount;
    return true;
}

function releaseCapital(principalUsd, pnlUsd) {
    const principal = Number(principalUsd || 0);
    const pnl = Number(pnlUsd || 0);
    const safePrincipal = Number.isFinite(principal) && principal > 0 ? principal : 0;
    const safePnl = Number.isFinite(pnl) ? pnl : 0;

    capitalState.lockedUsd = Math.max(0, capitalState.lockedUsd - safePrincipal);
    capitalState.availableUsd += safePrincipal + safePnl;

    // Clamp for floating point drift without masking real losses.
    if (Math.abs(capitalState.availableUsd) < 1e-9) {
        capitalState.availableUsd = 0;
    }
    if (Math.abs(capitalState.lockedUsd) < 1e-9) {
        capitalState.lockedUsd = 0;
    }
}

function renderAnimatedDashboard() {
    if (!CLI_ANIMATED) return;

    const C = {
        reset: '\x1b[0m',
        bold: '\x1b[1m',
        dim: '\x1b[2m',
        cyan: '\x1b[36m',
        green: '\x1b[32m',
        red: '\x1b[31m',
        yellow: '\x1b[33m',
        gray: '\x1b[90m'
    };

    const stripAnsi = (text) => String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
    const visibleLen = (text) => stripAnsi(text).length;
    const truncate = (text, width) => {
        const plain = stripAnsi(text);
        if (plain.length <= width) return text;
        return `${plain.slice(0, Math.max(0, width - 3))}...`;
    };
    const pad = (text, width, align = 'left') => {
        const t = truncate(text, width);
        const len = visibleLen(t);
        if (len >= width) return t;
        const spaces = ' '.repeat(width - len);
        if (align === 'right') return `${spaces}${t}`;
        if (align === 'center') {
            const left = Math.floor((width - len) / 2);
            const right = width - len - left;
            return `${' '.repeat(left)}${t}${' '.repeat(right)}`;
        }
        return `${t}${spaces}`;
    };

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const spinner = frames[cliState.spinnerIndex % frames.length];
    cliState.spinnerIndex += 1;
    cliState.lastRenderAt = nowMs;

    const cols = Math.max(90, process.stdout.columns || 120);
    const rows = Math.max(24, process.stdout.rows || 36);

    const activeTargets = orchestrator.positions.size;
    const openPositions = getOpenPositionsCount();
    const buyCount = cliState.eventCounts.get('paper_entry') || 0;
    const exitCount = cliState.eventCounts.get('paper_trade_result') || 0;
    const skipCount = cliState.eventCounts.get('trade_skipped') || 0;
    const ipcErrorCount = cliState.eventCounts.get('ipc_error') || 0;
    const execErrorCount = cliState.eventCounts.get('execution_error') || 0;

    const realized = cliState.realizedPnlUsd;
    const realizedColored = realized > 0
        ? `${C.green}$${realized.toFixed(2)}${C.reset}`
        : realized < 0
            ? `${C.red}$${realized.toFixed(2)}${C.reset}`
            : `${C.yellow}$${realized.toFixed(2)}${C.reset}`;

    const equity = currentEquityUsd();
    const equityColored = equity >= capitalState.initialUsd
        ? `${C.green}$${equity.toFixed(2)}${C.reset}`
        : `${C.red}$${equity.toFixed(2)}${C.reset}`;

    const rightRpc = orchestrator.reconnecting
        ? `${C.yellow}RPC reconnecting${C.reset}`
        : `${C.green}RPC online${C.reset}`;
    const rightExec = EXECUTION_ENABLED
        ? `${C.green}EXEC on${C.reset}`
        : `${C.yellow}EXEC off${C.reset}`;

    const headerLeft = `${C.bold}${C.cyan}MemeScanner Live Monitor${C.reset}`;
    const headerCenter = `${C.dim}${spinner}${C.reset} ${eventTime(nowIso)}  up ${formatUptime(uptimeSec())}`;
    const headerRight = `${rightRpc}  ${rightExec}`;

    const line = '─'.repeat(cols);
    const composeHeader = () => {
        const blank = ' '.repeat(cols);
        const arr = blank.split('');
        const writeAt = (text, start) => {
            const plain = stripAnsi(text);
            for (let i = 0; i < plain.length && start + i < arr.length; i++) {
                arr[start + i] = plain[i];
            }
        };
        const left = stripAnsi(headerLeft);
        const center = stripAnsi(headerCenter);
        const right = stripAnsi(headerRight);
        writeAt(left, 0);
        writeAt(center, Math.max(0, Math.floor((cols - center.length) / 2)));
        writeAt(right, Math.max(0, cols - right.length));
        const base = arr.join('');
        const lPad = pad(headerLeft, left.length);
        const cStart = Math.max(0, Math.floor((cols - center.length) / 2));
        const rStart = Math.max(0, cols - right.length);
        return `${base.slice(0, 0)}${lPad}${base.slice(left.length, cStart)}${headerCenter}${base.slice(cStart + center.length, rStart)}${headerRight}${base.slice(rStart + right.length)}`;
    };

    const stats = [
        `${C.bold}Trades${C.reset} ${buyCount}/${exitCount} skips:${skipCount}`,
        `${C.bold}PNL${C.reset} ${realizedColored}`,
        `${C.bold}Capital${C.reset} init:$${capitalState.initialUsd.toFixed(2)} avail:$${capitalState.availableUsd.toFixed(2)} locked:$${capitalState.lockedUsd.toFixed(2)} eq:${equityColored}`,
        `${C.bold}Sizing${C.reset} ${(Math.max(0, POSITION_SIZE_PCT) * 100).toFixed(1)}% cap:$${MAX_POSITION_USD.toFixed(0)} min:$${MIN_POSITION_USD.toFixed(0)} open:${openPositions}/${MAX_OPEN_POSITIONS}`
    ].join('  |  ');

    const gap = 1;
    const leftW = Math.floor((cols - 2 * gap) / 3);
    const centerW = Math.floor((cols - 2 * gap) / 3);
    const rightW = cols - leftW - centerW - 2 * gap;

    const footerLines = 2;
    const fixedRows = 4;
    const panelH = Math.max(10, rows - fixedRows - footerLines);

    const makeBox = (title, width, height, contentLines) => {
        const innerW = Math.max(4, width - 2);
        const topTitle = ` ${title} `;
        const top = `┌${truncate(topTitle, innerW).padEnd(innerW, '─')}┐`;
        const out = [top];
        const usable = Math.max(1, height - 2);
        for (let i = 0; i < usable; i++) {
            const txt = contentLines[i] || '';
            out.push(`│${pad(txt, innerW)}│`);
        }
        out.push(`└${'─'.repeat(innerW)}┘`);
        return out.slice(0, height);
    };

    const tickRows = Array.from(cliState.lastTicksByMint.entries())
        .map(([mint, tick]) => ({ mint, ...tick }))
        .sort((a, b) => Math.abs(Number(b.velocityUiPerSec || 0)) - Math.abs(Number(a.velocityUiPerSec || 0)))
        .slice(0, Math.max(4, panelH - 4));

    const leftContent = [];
    leftContent.push(`${C.gray}${pad('Mint', 12)} ${pad('Side', 5)} ${pad('Vel', 11, 'right')} ${pad('Sec', 3)} ${pad('Mom', 3)} ${pad('St', 4)}${C.reset}`);
    leftContent.push(`${C.gray}${'─'.repeat(Math.max(8, leftW - 4))}${C.reset}`);
    for (const row of tickRows) {
        const sideText = String(row.side || '-');
        const side = sideText === 'buy' ? `${C.green}BUY${C.reset}` : sideText === 'sell' ? `${C.red}SELL${C.reset}` : '-';
        const sec = row.securityPassed ? `${C.green}Y${C.reset}` : `${C.yellow}N${C.reset}`;
        const mom = row.momentumPassed ? `${C.green}Y${C.reset}` : `${C.yellow}N${C.reset}`;
        const st = isOpenPositionForMint(row.mint) ? `${C.green}OPEN${C.reset}` : `${C.gray}flat${C.reset}`;
        leftContent.push(`${pad(shortMint(row.mint), 12)} ${pad(side, 5)} ${pad(Number(row.velocityUiPerSec || 0).toFixed(0), 11, 'right')} ${pad(sec, 3)} ${pad(mom, 3)} ${pad(st, 4)}`);
    }
    if (!tickRows.length) {
        leftContent.push(`${C.gray}Waiting for AMM ticks...${C.reset}`);
    }

    const openRows = Array.from(orchestrator.positions.values()).filter((p) => p.isOpen).slice(0, Math.max(4, panelH - 4));
    const centerContent = [];
    centerContent.push(`${C.gray}${pad('Mint', 12)} ${pad('Mode', 6)} ${pad('Size$', 8, 'right')} ${pad('Age', 8, 'right')}${C.reset}`);
    centerContent.push(`${C.gray}${'─'.repeat(Math.max(8, centerW - 4))}${C.reset}`);
    for (const p of openRows) {
        const ageSec = p.entryAtMs ? Math.max(0, Math.floor((nowMs - p.entryAtMs) / 1000)) : 0;
        const age = `${Math.floor(ageSec / 60)}m${String(ageSec % 60).padStart(2, '0')}s`;
        centerContent.push(`${pad(shortMint(p.mint), 12)} ${pad(String(p.mode || 'paper'), 6)} ${pad(Number(p.amountUsd || 0).toFixed(2), 8, 'right')} ${pad(age, 8, 'right')}`);
    }
    if (!openRows.length) {
        centerContent.push(`${C.gray}No open positions${C.reset}`);
    }

    const recent = cliState.recentImportant.slice(-Math.max(8, panelH - 3));
    const rightContent = [];
    if (!recent.length) {
        rightContent.push(`${C.gray}No recent activity${C.reset}`);
    } else {
        for (const entry of recent) {
            rightContent.push(truncate(entry, Math.max(8, rightW - 4)));
        }
    }

    const leftBox = makeBox('Top Active Mints', leftW, panelH, leftContent);
    const centerBox = makeBox('Open Positions', centerW, panelH, centerContent);
    const rightBox = makeBox('Recent Activity', rightW, panelH, rightContent);

    // Cache git status briefly to avoid shelling out every frame.
    if (!renderAnimatedDashboard._gitCacheAt || nowMs - renderAnimatedDashboard._gitCacheAt > 5000) {
        try {
            const { execSync } = require('child_process');
            const raw = String(execSync('git --no-pager status --porcelain -b', { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }) || '');
            const linesRaw = raw.trim().split('\n').filter(Boolean);
            const branch = (linesRaw[0] || '').replace(/^##\s*/, '') || 'detached';
            const dirty = Math.max(0, linesRaw.length - 1);
            renderAnimatedDashboard._gitCache = `${branch} | dirty:${dirty}`;
        } catch {
            renderAnimatedDashboard._gitCache = 'git:n/a';
        }
        renderAnimatedDashboard._gitCacheAt = nowMs;
    }

    const footerLeft = sessionState.initialized
        ? `events:${sessionState.rawEventsPath}`
        : 'events:disabled';
    const footerRight = `git:${renderAnimatedDashboard._gitCache || 'n/a'}  ipc:${ipcErrorCount} exec:${execErrorCount}`;

    const frame = [];
    frame.push(composeHeader());
    frame.push(line);
    frame.push(truncate(stats, cols));
    frame.push(line);
    for (let i = 0; i < panelH; i++) {
        frame.push(`${leftBox[i] || ''.padEnd(leftW, ' ')}${' '.repeat(gap)}${centerBox[i] || ''.padEnd(centerW, ' ')}${' '.repeat(gap)}${rightBox[i] || ''.padEnd(rightW, ' ')}`);
    }
    frame.push(line);
    frame.push(truncate(`${footerLeft}  |  ${footerRight}`, cols));

    process.stdout.write(`${ANSI.cursorHome}${ANSI.clearDown}${frame.join('\n')}`);
}

function startCliRenderer() {
    if (!CLI_ANIMATED || cliState.rendererActive) return;
    cliState.rendererActive = true;

    // Enter alternate screen for a clean full-frame dashboard.
    process.stdout.write(`\x1b[?1049h${ANSI.hideCursor}${ANSI.clearScreen}${ANSI.cursorHome}`);
    renderAnimatedDashboard();
    cliState.rendererTimer = setInterval(renderAnimatedDashboard, Math.max(200, CLI_REFRESH_MS));
}

function stopCliRenderer() {
    if (!cliState.rendererActive) return;
    if (cliState.rendererTimer) {
        clearInterval(cliState.rendererTimer);
        cliState.rendererTimer = null;
    }
    cliState.rendererActive = false;

    // Leave alternate screen and restore cursor.
    process.stdout.write(`${ANSI.showCursor}${ANSI.reset}\x1b[?1049l`);
}

function countEvent(type) {
    const prev = cliState.eventCounts.get(type) || 0;
    cliState.eventCounts.set(type, prev + 1);
}

function renderTickSummary(ts) {
    const activeTargets = orchestrator.positions.size;
    const openPositions = getOpenPositionsCount();
    const last = cliState.lastTick;
    if (!last) return;

    const summary = `[${ts}] flow active=${activeTargets} open=${openPositions}/${MAX_OPEN_POSITIONS} mint=${shortMint(last.mint)} side=${last.side || '-'} vel=${Number(last.velocityUiPerSec || 0).toFixed(3)} sec=${last.securityPassed ? 'ok' : 'no'} mom=${last.momentumPassed ? 'ok' : 'no'}`;
    process.stdout.write(`${summary}\n`);
}

function formatImportantEvent(payload) {
    const ts = eventTime(payload.ts);
    const mint = shortMint(payload.mint);

    switch (payload.type) {
        case 'ready':
            return `[${ts}] ready rpc=online active=${payload.activeTargets || 0} execution=${payload.executionEnabled ? 'on' : 'off'}`;
        case 'target_ready':
            return `[${ts}] target+ ${mint} mode=${payload.mode} active=${payload.activeTargets}`;
        case 'target_cleanup':
            return `[${ts}] target- ${mint} reason=${payload.reason || 'cleanup'} active=${payload.activeTargets}`;
        case 'paper_entry':
            return `[${ts}] paper buy ${mint} price=${payload.price || '-'} usd=${payload.amountUsd || 0}`;
        case 'paper_trade_result':
            return `[${ts}] paper exit ${mint} pnl=${Number(payload.netPnlPct || 0).toFixed(2)}% usd=${Number(payload.netPnlUsd || 0).toFixed(2)} reason=${payload.reason || '-'}`;
        case 'trade_skipped':
            return `[${ts}] skip ${payload.side || '-'} ${mint} reason=${payload.reason || '-'}`;
        case 'target_rejected':
            return `[${ts}] target x ${mint} reason=${payload.reason || '-'} active=${payload.activeTargets ?? '-'}`;
        case 'target_deferred':
            return `[${ts}] target ~ ${mint} deferred reason=${payload.reason || '-'} open=${payload.openPositions ?? '-'}/${payload.maxOpenPositions ?? '-'}`;
        case 'execution_error':
            return `[${ts}] error ${payload.side || '-'} ${mint} ${payload.message || ''}`;
        case 'ipc_error':
            return `[${ts}] ipc error ${payload.message || ''}`;
        case 'rpc_reconnect':
            return `[${ts}] rpc ${payload.stage || 'event'} reason=${payload.reason || '-'} attempt=${payload.attempt ?? '-'}`;
        case 'execution':
            return `[${ts}] live ${payload.side || '-'} ${mint} sig=${shortMint(payload.signature || '')}`;
        default:
            return null;
    }
}

function emit(payload) {
    if (!payload || typeof payload !== 'object') {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
        return;
    }

    const type = String(payload.type || 'event');
    countEvent(type);
    recordSessionEvent(type, payload);

    if (!CLI_PRETTY || CLI_JSON) {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
        return;
    }

    if (type === 'metadata') {
        return;
    }

    if (type === 'toxicity_error') {
        const key = `${payload.mint || 'unknown'}:${payload.message || ''}`;
        const now = Date.now();
        const lastAt = cliState.toxicityErrorSeenAt.get(key) || 0;
        if (now - lastAt < CLI_ERROR_DEDUP_MS) {
            return;
        }
        cliState.toxicityErrorSeenAt.set(key, now);
    }

    if (type === 'ipc_error') {
        cliState.lastIpcError = String(payload.message || '').trim();
        cliState.lastIpcErrorAt = Date.now();
    }

    if (type === 'amm_tick') {
        cliState.lastTick = payload;
        cliState.lastTicksByMint.set(String(payload.mint || ''), {
            mint: payload.mint,
            ts: payload.ts,
            side: payload.side,
            velocityUiPerSec: payload.velocityUiPerSec,
            securityPassed: payload.securityPassed,
            momentumPassed: payload.momentumPassed
        });

        // Keep memory bounded for long sessions.
        if (cliState.lastTicksByMint.size > 40) {
            const first = cliState.lastTicksByMint.keys().next().value;
            if (first) cliState.lastTicksByMint.delete(first);
        }

        if (CLI_ANIMATED) {
            return;
        }

        const now = Date.now();
        if (now - cliState.lastTickSummaryAt >= CLI_TICK_SUMMARY_MS) {
            cliState.lastTickSummaryAt = now;
            renderTickSummary(eventTime(payload.ts));
        }
        return;
    }

    const line = formatImportantEvent(payload);
    if (line) {
        pushRecentImportant(line);
        if (!CLI_ANIMATED) {
            process.stdout.write(`${line}\n`);
        }
        return;
    }

    if (!CLI_ANIMATED) {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
}

function broadcastIpc(payload) {
    const serialized = JSON.stringify(payload);
    for (const client of orchestrator.ipcClients) {
        if (!client || client.readyState !== 1) continue;
        try {
            client.send(serialized);
        } catch {}
    }
}

function createConnection() {
    return new Connection(STAKED_RPC_HTTP_URL, {
        wsEndpoint: STAKED_RPC_WS_URL,
        commitment: COMMITMENT
    });
}

function parseWalletFromEnv(secretKeyText) {
    if (!secretKeyText) return null;
    try {
        if (secretKeyText.trim().startsWith('[')) {
            return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyText)));
        }
        const arr = secretKeyText
            .split(',')
            .map((x) => Number(x.trim()))
            .filter((x) => Number.isFinite(x));
        if (arr.length > 0) {
            return Keypair.fromSecretKey(Uint8Array.from(arr));
        }
    } catch (error) {
        status(`Wallet parse failed: ${error.message}`);
    }
    return null;
}

function parsePercentLike(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const match = String(value).trim().match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
}

function parseMarketCapLike(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const cleaned = String(value).trim().replace(/[$,\s]/g, '').toUpperCase();
    const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/);
    if (!match) return null;
    const base = Number(match[1]);
    const multipliers = { '': 1, K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
    return base * (multipliers[match[2] || ''] || 1);
}

function parseBooleanLike(value) {
    if (typeof value === 'boolean') return value;
    if (value === null || value === undefined) return null;
    const str = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'burned', 'lp burned', 'locked'].includes(str)) return true;
    if (['false', '0', 'no', 'not burned', 'unlocked'].includes(str)) return false;
    return null;
}

function formatAmount(rawAmount, decimals) {
    const negative = rawAmount < 0n;
    const value = negative ? -rawAmount : rawAmount;
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = value % base;
    if (decimals === 0) return `${negative ? '-' : ''}${whole.toString()}`;
    const fractionPadded = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fractionPadded
        ? `${negative ? '-' : ''}${whole.toString()}.${fractionPadded}`
        : `${negative ? '-' : ''}${whole.toString()}`;
}

function formatScaledPrice(priceScaled) {
    const scale = 1_000_000_000_000n;
    const whole = priceScaled / scale;
    const frac = (priceScaled % scale).toString().padStart(12, '0').replace(/0+$/, '');
    return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

function attachWsCloseHooks() {
    if (!orchestrator.connection || orchestrator.wsHooked) return;
    const internal = orchestrator.connection._rpcWebSocket;
    if (!internal || typeof internal.on !== 'function') return;
    try {
        internal.on('close', () => scheduleReconnect('ws_close'));
        internal.on('error', () => scheduleReconnect('ws_error'));
        orchestrator.wsHooked = true;
    } catch {}
}

function newPositionState({ mint, mode, amountUsd }) {
    const now = Date.now();
    return {
        mint,
        mode: mode === 'live' ? 'live' : 'paper',
        isPaper: mode !== 'live',
        amountUsd: Number(amountUsd) > 0 ? Number(amountUsd) : 100,
        mintDecimals: 0,
        mintProgram: null,
        mintSupplyRaw: 0n,
        userAta: null,
        requiresAtaCreation: false,
        ammVault: null,
        lastVaultAmount: null,
        metadata: {
            marketCap: null,
            top10Pct: null,
            bundlersPct: null,
            devPct: null,
            lpBurned: null,
            platform: null,
            sourceHost: null,
            updatedAt: null,
            pump: {}
        },
        securityPassed: false,
        momentumPassed: false,
        velocityEvents: [],
        velocitySamples: [],
        createdAt: now,
        lastSeenAt: now,
        lastVaultTickAt: 0,
        recentFailures: 0,
        isOpen: false,
        isExecuting: false,
        entryAtMs: 0,
        entryPriceScaled: null,
        peakPriceScaled: null,
        lastActionAt: 0,
        lastSkipAt: new Map(),
        subscriptionId: null,
        logsSubscriptionId: null,
        idempotencyKeys: new Map()
    };
}

function shouldEmitSkip(position, reason, now) {
    const key = String(reason || 'unknown');
    const last = position.lastSkipAt.get(key) || 0;
    if (now - last < SKIP_EMIT_COOLDOWN_MS) {
        return false;
    }
    position.lastSkipAt.set(key, now);
    return true;
}

async function resolveAmmVaultAddress(position) {
    if (position.ammVault) return new PublicKey(position.ammVault);

    const mintPublicKey = new PublicKey(position.mint);
    const platform = String(position.metadata?.platform || '').toLowerCase();
    if (platform.includes('pump')) {
        const pumpProgram = new PublicKey(PUMP_PROGRAM_ID);
        const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from('bonding-curve'), mintPublicKey.toBuffer()],
            pumpProgram
        );

        const associatedBondingCurve = await getAssociatedTokenAddress(
            mintPublicKey,
            bondingCurve,
            true,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        position.metadata.pump = {
            ...(position.metadata.pump || {}),
            programId: pumpProgram.toBase58(),
            bondingCurve: bondingCurve.toBase58(),
            associatedBondingCurve: associatedBondingCurve.toBase58()
        };
        position.ammVault = associatedBondingCurve.toBase58();
        return associatedBondingCurve;
    }

    const largest = await orchestrator.connection.getTokenLargestAccounts(mintPublicKey, COMMITMENT);
    const first = largest?.value?.find((x) => x?.address);
    if (!first) {
        throw new Error(`Unable to resolve AMM vault for mint ${position.mint}`);
    }
    position.ammVault = first.address.toBase58();
    return first.address;
}
function computeVirtualPriceScaled(position, vaultAmountRaw) {
    const scale = 1_000_000_000_000n;
    const supply = position.mintSupplyRaw > 0n ? position.mintSupplyRaw : 1n;
    const amount = vaultAmountRaw > 0n ? vaultAmountRaw : 1n;
    return (scale * supply) / amount;
}

function updateSecurityState(position) {
    const top10 = parsePercentLike(position.metadata.top10Pct);
    const bundlers = parsePercentLike(position.metadata.bundlersPct);
    const dev = parsePercentLike(position.metadata.devPct);
    position.metadata.top10Pct = top10;
    position.metadata.bundlersPct = bundlers;
    position.metadata.devPct = dev;

    const top10Ok = top10 !== null && top10 <= MAX_TOP10_PCT;
    const bundlersOk = bundlers !== null && bundlers <= MAX_BUNDLERS_PCT;
    const devOk = dev !== null && dev <= MAX_DEV_PCT;
    const lpOk = REQUIRE_LP_BURN ? position.metadata.lpBurned === true : true;
    position.securityPassed = top10Ok && bundlersOk && devOk && lpOk;
}

function pruneVelocity(position, now) {
    position.velocityEvents = position.velocityEvents.filter((x) => now - x.ts <= VELOCITY_WINDOW_MS);
}

function computeVelocity(position, now) {
    pruneVelocity(position, now);
    if (!position.velocityEvents.length) return 0;
    const seconds = Math.max(1, VELOCITY_WINDOW_MS / 1000);
    const sum = position.velocityEvents.reduce((acc, x) => acc + x.deltaUi, 0);
    return sum / seconds;
}

function updateMomentumState(position, now) {
    const v = computeVelocity(position, now);
    position.velocitySamples.push({ ts: now, velocity: v });
    position.velocitySamples = position.velocitySamples.filter((x) => now - x.ts <= VELOCITY_WINDOW_MS);
    position.momentumPassed = v >= MIN_BUY_VELOCITY;
    return v;
}

function isVelocityExhausted(position, currentVelocity, now) {
    const samples = position.velocitySamples.filter((x) => now - x.ts <= VELOCITY_WINDOW_MS);
    if (!samples.length) return false;
    const peakVelocity = samples.reduce((max, x) => Math.max(max, x.velocity), Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(peakVelocity) || peakVelocity <= 0) return false;
    return currentVelocity <= peakVelocity * 0.5;
}

function shouldTriggerTrailingStop(position, currentPriceScaled) {
    if (!position.isOpen || currentPriceScaled <= 0n) return false;

    if (position.peakPriceScaled === null || position.peakPriceScaled <= 0n) {
        position.peakPriceScaled = currentPriceScaled;
        return false;
    }

    if (currentPriceScaled > position.peakPriceScaled) {
        position.peakPriceScaled = currentPriceScaled;
        return false;
    }

    const drawdownScaled = ((position.peakPriceScaled - currentPriceScaled) * 10_000n) / position.peakPriceScaled;
    return Number(drawdownScaled) / 10_000 >= TRAILING_STOP_DRAWDOWN;
}

function computePnlPct(position, priceScaled) {
    if (!position || !position.entryPriceScaled || position.entryPriceScaled <= 0n || !priceScaled || priceScaled <= 0n) {
        return 0;
    }
    const pnlPct = Number(((priceScaled - position.entryPriceScaled) * 10_000n) / position.entryPriceScaled) / 100;
    return Number.isFinite(pnlPct) ? pnlPct : 0;
}

function shouldProtectProfit(position, currentPriceScaled) {
    if (!position?.isOpen || !position.entryPriceScaled || !position.peakPriceScaled) {
        return false;
    }

    const peakPnlPct = computePnlPct(position, position.peakPriceScaled);
    const currentPnlPct = computePnlPct(position, currentPriceScaled);
    return peakPnlPct >= LOCKED_PROFIT_TRIGGER_PCT && currentPnlPct <= LOCKED_PROFIT_FLOOR_PCT;
}

function pruneIdempotencyKeys(position, now) {
    for (const [key, ts] of position.idempotencyKeys.entries()) {
        if (now - ts > IDEMPOTENCY_KEY_TTL_MS) {
            position.idempotencyKeys.delete(key);
        }
    }
}

function claimIdempotencyKey(position, side, now, source) {
    pruneIdempotencyKeys(position, now);
    const window = Math.floor(now / IDEMPOTENCY_WINDOW_MS);
    const openFlag = position.isOpen ? 'open' : 'flat';
    const key = `${position.mint}:${side}:${source}:${window}:${openFlag}`;
    if (position.idempotencyKeys.has(key)) return null;
    position.idempotencyKeys.set(key, now);
    return key;
}

function getComputeUnitLimit(platform) {
    const normalized = String(platform || '').toLowerCase();
    if (normalized.includes('raydium')) return 250000;
    return 100000;
}

function getOpenPositionsCount() {
    let count = 0;
    for (const position of orchestrator.positions.values()) {
        if (position.isOpen) {
            count += 1;
        }
    }
    return count;
}

async function calculateDynamicCuPrice(position) {
    const feeSamples = await orchestrator.connection.getRecentPrioritizationFees();
    const samples = (feeSamples || [])
        .slice(-DYNAMIC_FEE_WINDOW)
        .map((x) => Number(x.prioritizationFee || 0))
        .filter((x) => Number.isFinite(x) && x >= 0)
        .sort((a, b) => a - b);

    const median = samples.length ? samples[Math.floor(samples.length / 2)] : 0;
    const contentionDetected = position.recentFailures > 0;
    const multiplier = contentionDetected
        ? Math.min(CONTENTION_MULTIPLIER_CAP, Math.pow(BASE_CONTENTION_MULTIPLIER, Math.min(6, position.recentFailures)))
        : 1;

    return {
        medianMicroLamports: median,
        finalMicroLamports: Math.max(1, Math.floor(median * multiplier) || 1),
        contentionDetected,
        multiplier
    };
}

function parsePubkeyMaybe(value) {
    try {
        return value ? new PublicKey(String(value)) : null;
    } catch {
        return null;
    }
}

function parseDiscriminatorHex(text) {
    const cleaned = String(text || '').trim().toLowerCase().replace(/^0x/, '');
    if (!cleaned || cleaned.length % 2 !== 0 || !/^[0-9a-f]+$/.test(cleaned)) return null;
    return Buffer.from(cleaned, 'hex');
}

function parsePumpBondingCurveState(data) {
    if (!Buffer.isBuffer(data) || data.length < 40) {
        throw new Error('Invalid bonding curve account payload.');
    }

    return {
        virtualTokenReserves: data.readBigUInt64LE(8),
        virtualSolReserves: data.readBigUInt64LE(16),
        realTokenReserves: data.readBigUInt64LE(24),
        realSolReserves: data.readBigUInt64LE(32)
    };
}

function usdToLamports(usdAmount) {
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) return 0n;
    const solAmount = usdAmount / Math.max(0.000001, SOL_PRICE_USD);
    return BigInt(Math.floor(solAmount * 1_000_000_000));
}

async function computeDynamicBuySizing(position) {
    const bondingCurveAddress = position.metadata?.pump?.bondingCurve;
    if (!bondingCurveAddress) {
        throw new Error('Missing bondingCurve for buy sizing.');
    }

    const solToSpend = usdToLamports(Number(position.amountUsd || 0));
    if (solToSpend <= 0n) {
        return { amountRaw: 0n, limitRaw: 0n };
    }

    const maxSolCost = (solToSpend * BigInt(10000 + STRICT_SLIPPAGE_BPS) + 9999n) / 10000n;

    const curveInfo = await orchestrator.connection.getAccountInfo(new PublicKey(bondingCurveAddress), COMMITMENT);
    if (!curveInfo?.data) {
        throw new Error('Bonding curve account not found.');
    }

    const curve = parsePumpBondingCurveState(curveInfo.data);
    const vToken = curve.virtualTokenReserves;
    const vSol = curve.virtualSolReserves;
    if (vToken <= 0n || vSol <= 0n) {
        throw new Error('Virtual reserves are zero; cannot size buy.');
    }

    const k = vToken * vSol;
    const newVSol = vSol + solToSpend;
    const newVToken = k / newVSol;
    const tokensToBuy = vToken > newVToken ? vToken - newVToken : 0n;

    return {
        amountRaw: tokensToBuy,
        limitRaw: maxSolCost
    };
}

async function computeDynamicSellSizing(position) {
    if (!position.userAta) {
        return { amountRaw: 0n, limitRaw: 0n };
    }

    try {
        const ata = new PublicKey(position.userAta);
        const ataInfo = await orchestrator.connection.getAccountInfo(ata, COMMITMENT);
        if (!ataInfo) {
            return { amountRaw: 0n, limitRaw: 0n };
        }

        const decoded = unpackAccount(ata, ataInfo, ataInfo.owner);
        return {
            amountRaw: decoded.amount,
            limitRaw: 0n
        };
    } catch {
        return {
            amountRaw: 0n,
            limitRaw: 0n
        };
    }
}

function encodePumpInstructionData(side, amountRaw, limitRaw) {
    const buyDiscriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    const sellDiscriminator = parseDiscriminatorHex(PUMP_SELL_DISCRIMINATOR);
    const discriminator = side === 'buy' ? buyDiscriminator : sellDiscriminator;
    if (!discriminator || discriminator.length !== 8) {
        throw new Error('Missing or invalid sell discriminator env var (8-byte hex required).');
    }

    const data = Buffer.alloc(24);
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amountRaw), 8);
    data.writeBigUInt64LE(BigInt(limitRaw), 16);
    return data;
}

async function buildPumpInstructions(position, side, amountRaw, limitRaw) {
    if (!orchestrator.wallet) {
        throw new Error('Wallet missing for live execution.');
    }

    const mint = new PublicKey(position.mint);
    const userAta = position.userAta ? new PublicKey(position.userAta) : await getAssociatedTokenAddress(mint, orchestrator.wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    const pump = position.metadata.pump || {};
    const global = parsePubkeyMaybe(pump.global || PUMP_GLOBAL);
    const feeRecipient = parsePubkeyMaybe(pump.feeRecipient || PUMP_FEE_RECIPIENT);
    const bondingCurve = parsePubkeyMaybe(pump.bondingCurve);
    const associatedBondingCurve = parsePubkeyMaybe(pump.associatedBondingCurve || position.ammVault);
    const eventAuthority = parsePubkeyMaybe(pump.eventAuthority || PUMP_EVENT_AUTHORITY);
    const programId = parsePubkeyMaybe(pump.programId || PUMP_PROGRAM_ID);

    if (!global || !feeRecipient || !bondingCurve || !associatedBondingCurve || !eventAuthority || !programId) {
        throw new Error('Pump account metadata incomplete. Required: global, feeRecipient, bondingCurve, associatedBondingCurve, eventAuthority.');
    }

    const ixs = [];
    if (position.requiresAtaCreation) {
        ixs.push(
            createAssociatedTokenAccountInstruction(
                orchestrator.wallet.publicKey,
                userAta,
                orchestrator.wallet.publicKey,
                mint,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );
        // Once emitted for the first buy, avoid repeating ATA create on subsequent actions (sell/next buy).
        position.requiresAtaCreation = false;
    }

    const keys = [
        { pubkey: global, isSigner: false, isWritable: false },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: orchestrator.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: eventAuthority, isSigner: false, isWritable: false },
        { pubkey: programId, isSigner: false, isWritable: false }
    ];

    ixs.push(
        new TransactionInstruction({
            programId,
            keys,
            data: encodePumpInstructionData(side, amountRaw, limitRaw)
        })
    );

    return ixs;
}

async function submitDirectSwap(position, side, amountRaw, limitRaw) {
    if (!EXECUTION_ENABLED) {
        emit({ type: 'execution_skipped', ts: new Date().toISOString(), mint: position.mint, side, reason: 'EXECUTION_ENABLED is not set' });
        return null;
    }

    if (!orchestrator.wallet) {
        throw new Error('Wallet is not configured. Set WALLET_SECRET_KEY to enable execution.');
    }

    const platform = String(position.metadata?.platform || '').toLowerCase();
    if (platform.includes('raydium')) {
        emit({
            type: 'trade_skipped',
            ts: new Date().toISOString(),
            mint: position.mint,
            side,
            reason: 'raydium_not_implemented'
        });
        return null;
    }

    if (!platform.includes('pump')) {
        emit({
            type: 'trade_skipped',
            ts: new Date().toISOString(),
            mint: position.mint,
            side,
            reason: 'unsupported_platform'
        });
        return null;
    }

    const safeAmountRaw = BigInt(amountRaw || 0);
    const safeLimitRaw = BigInt(limitRaw || 0);
    if (safeAmountRaw <= 0n) {
        emit({
            type: 'trade_skipped',
            ts: new Date().toISOString(),
            mint: position.mint,
            side,
            reason: 'non_positive_amount'
        });
        return null;
    }

    const fee = await calculateDynamicCuPrice(position);
    const cuLimit = getComputeUnitLimit(position.metadata.platform);
    const swapIxs = await buildPumpInstructions(position, side, safeAmountRaw, safeLimitRaw);

    const { blockhash, lastValidBlockHeight } = await orchestrator.connection.getLatestBlockhash(COMMITMENT);
    const message = new TransactionMessage({
        payerKey: orchestrator.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee.finalMicroLamports }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
            ...swapIxs
        ]
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([orchestrator.wallet]);

    const signature = await orchestrator.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2
    });

    const confirmation = await orchestrator.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, COMMITMENT);
    if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    emit({
        type: 'execution',
        ts: new Date().toISOString(),
        mint: position.mint,
        mode: position.mode,
        side,
        amountRaw: safeAmountRaw.toString(),
        limitRaw: safeLimitRaw.toString(),
        signature,
        cuPriceMicroLamports: fee.finalMicroLamports,
        cuMedianMicroLamports: fee.medianMicroLamports,
        contentionDetected: fee.contentionDetected,
        contentionMultiplier: fee.multiplier,
        computeUnitLimit: cuLimit
    });

    position.recentFailures = 0;
    return signature;
}

function paperOpen(position, now, priceScaled) {
    const reserved = allocateCapital(position.amountUsd);
    if (!reserved) {
        emit({
            type: 'trade_skipped',
            ts: new Date(now).toISOString(),
            mint: position.mint,
            side: 'buy',
            reason: 'insufficient_capital',
            neededUsd: Number(position.amountUsd || 0),
            availableUsd: Number(capitalState.availableUsd.toFixed(2))
        });
        return false;
    }

    position.isOpen = true;
    position.entryAtMs = now;
    position.entryPriceScaled = priceScaled;
    position.peakPriceScaled = priceScaled;

    emit({
        type: 'paper_entry',
        ts: new Date(now).toISOString(),
        mint: position.mint,
        price: formatScaledPrice(priceScaled),
        amountUsd: position.amountUsd
    });

    return true;
}
function paperClose(position, now, exitPriceScaled, reason) {
    if (!position.isOpen || position.entryPriceScaled === null) return;

    const entry = position.entryPriceScaled;
    const pnlPct = Number(((exitPriceScaled - entry) * 10_000n) / (entry > 0n ? entry : 1n)) / 100;
    const netPnlUsd = (position.amountUsd * pnlPct) / 100;
    const durationMs = Math.max(0, now - position.entryAtMs);

    releaseCapital(position.amountUsd, netPnlUsd);

    emit({
        type: 'paper_trade_result',
        ts: new Date(now).toISOString(),
        mint: position.mint,
        reason,
        entryPrice: formatScaledPrice(entry),
        exitPrice: formatScaledPrice(exitPriceScaled),
        netPnlUsd,
        netPnlPct: pnlPct,
        tradeDurationMs: durationMs,
        entryAt: new Date(position.entryAtMs).toISOString(),
        exitAt: new Date(now).toISOString()
    });
}

async function cleanupPosition(position, reason) {
    try {
        if (position.subscriptionId !== null) {
            await orchestrator.connection.removeAccountChangeListener(position.subscriptionId);
            position.subscriptionId = null;
        }
    } catch {}
    try {
        if (position.logsSubscriptionId !== null) {
            await orchestrator.connection.removeOnLogsListener(position.logsSubscriptionId);
            position.logsSubscriptionId = null;
        }
    } catch {}

    orchestrator.positions.delete(position.mint);

    broadcastIpc({
        type: 'target_cleanup',
        mint: position.mint
    });

    emit({
        type: 'target_cleanup',
        ts: new Date().toISOString(),
        mint: position.mint,
        reason,
        activeTargets: orchestrator.positions.size
    });

    await maybePromoteDeferredTarget();
}

async function closePosition(position, now, reason, currentPriceScaled) {
    if (position.isPaper) {
        paperClose(position, now, currentPriceScaled, reason);
        await cleanupPosition(position, reason);
        return;
    }

    position.isExecuting = true;
    try {
        const sellSizing = await computeDynamicSellSizing(position);
        if (sellSizing.amountRaw <= 0n) {
            emit({
                type: 'trade_skipped',
                ts: new Date().toISOString(),
                mint: position.mint,
                side: 'sell',
                reason: 'no_token_balance'
            });
            await cleanupPosition(position, `${reason}:no_token_balance`);
            return;
        }

        const sig = await submitDirectSwap(position, 'sell', sellSizing.amountRaw, sellSizing.limitRaw);
        if (sig) {
            await cleanupPosition(position, reason);
        }
    } catch (error) {
        position.recentFailures += 1;
        emit({ type: 'execution_error', ts: new Date().toISOString(), mint: position.mint, side: 'sell', message: error.message });
    } finally {
        position.isExecuting = false;
    }
}

async function maybeExecuteStrategy(position, now, velocityUiPerSec, currentPriceScaled) {
    if (position.isExecuting) return;
    if (now - position.lastActionAt < 3000) return;

    updateSecurityState(position);

    if (!position.isOpen) {
        if (position.securityPassed && position.momentumPassed) {
            const resources = canOpenByResources();
            if (!resources.ok) {
                if (!shouldEmitSkip(position, resources.reason, now)) {
                    return;
                }

                emit({
                    type: 'trade_skipped',
                    ts: new Date().toISOString(),
                    mint: position.mint,
                    side: 'buy',
                    reason: resources.reason,
                    maxOpenPositions: MAX_OPEN_POSITIONS,
                    availableUsd: Number(capitalState.availableUsd.toFixed(2)),
                    plannedUsd: Number((resources.plannedUsd || 0).toFixed(2)),
                    minPositionUsd: MIN_POSITION_USD
                });
                return;
            }

            position.amountUsd = Number(resources.plannedUsd || position.amountUsd || 0);

            const key = claimIdempotencyKey(position, 'buy', now, 'strategy');
            if (!key) {
                emit({ type: 'idempotency_skip', ts: new Date().toISOString(), mint: position.mint, side: 'buy', source: 'strategy' });
                return;
            }

            position.isExecuting = true;
            try {
                if (position.isPaper) {
                    const opened = paperOpen(position, now, currentPriceScaled);
                    if (!opened) {
                        return;
                    }
                } else {
                    const buySizing = await computeDynamicBuySizing(position);
                    if (buySizing.amountRaw <= 0n) {
                        emit({
                            type: 'trade_skipped',
                            ts: new Date().toISOString(),
                            mint: position.mint,
                            side: 'buy',
                            reason: 'invalid_buy_sizing'
                        });
                        return;
                    }

                    const sig = await submitDirectSwap(position, 'buy', buySizing.amountRaw, buySizing.limitRaw);
                    if (sig) {
                        position.isOpen = true;
                        position.entryAtMs = now;
                        position.entryPriceScaled = currentPriceScaled;
                        position.peakPriceScaled = currentPriceScaled;
                    }
                }
                position.lastActionAt = now;
            } catch (error) {
                position.recentFailures += 1;
                emit({ type: 'execution_error', ts: new Date().toISOString(), mint: position.mint, side: 'buy', message: error.message });
            } finally {
                position.isExecuting = false;
            }
        }
        return;
    }

    const trailingStopHit = shouldTriggerTrailingStop(position, currentPriceScaled);
    const velocityExhausted = isVelocityExhausted(position, velocityUiPerSec, now);
    const staleOpenHit = OPEN_STALE_EXIT_MS > 0 && position.lastVaultTickAt > 0 && now - position.lastVaultTickAt >= OPEN_STALE_EXIT_MS;
    const protectProfitHit = shouldProtectProfit(position, currentPriceScaled);

    if (trailingStopHit || velocityExhausted || staleOpenHit || protectProfitHit) {
        const key = claimIdempotencyKey(position, 'sell', now, 'strategy');
        if (!key) {
            emit({ type: 'idempotency_skip', ts: new Date().toISOString(), mint: position.mint, side: 'sell', source: 'strategy' });
            return;
        }

        position.lastActionAt = now;
        let reason = 'velocity_exhaustion';
        if (trailingStopHit) reason = 'trailing_stop';
        else if (protectProfitHit) reason = 'locked_profit_retrace';
        else if (staleOpenHit) reason = 'stale_open_timeout';
        await closePosition(position, now, reason, currentPriceScaled);
    }
}

function mergeMetadataForPosition(position, payload) {
    position.metadata.marketCap = parseMarketCapLike(payload.marketCap ?? payload.mc ?? payload.market_cap ?? position.metadata.marketCap);
    position.metadata.top10Pct = parsePercentLike(payload.top10Pct ?? payload.topHolders ?? position.metadata.top10Pct);
    position.metadata.bundlersPct = parsePercentLike(payload.bundlersPct ?? payload.bundlePct ?? position.metadata.bundlersPct);
    position.metadata.devPct = parsePercentLike(payload.devPct ?? payload.insiderPct ?? position.metadata.devPct);
    position.metadata.lpBurned = parseBooleanLike(payload.lpBurned ?? payload.lpBurn ?? position.metadata.lpBurned);
    position.metadata.platform = payload.platform || position.metadata.platform;
    position.metadata.sourceHost = payload.sourceHost || position.metadata.sourceHost;
    position.metadata.updatedAt = Date.now();

    if (payload.pump && typeof payload.pump === 'object') {
        position.metadata.pump = {
            ...position.metadata.pump,
            ...payload.pump
        };
    }

    updateSecurityState(position);
    emit({ type: 'metadata', ts: new Date().toISOString(), mint: position.mint, metadata: position.metadata, securityPassed: position.securityPassed });
}

function txHasToxicInstruction(tx, mint) {
    const dangerous = new Set(['mintTo', 'mintToChecked', 'setAuthority', 'freezeAccount', 'initializeMint', 'initializeMint2']);
    const inspectParsed = (parsedIx) => {
        if (!parsedIx || !parsedIx.parsed) return false;
        const type = parsedIx.parsed.type;
        if (!dangerous.has(type)) return false;
        const info = parsedIx.parsed.info || {};
        const candidateMint = info.mint || info.account || '';
        return candidateMint === mint;
    };

    const outer = tx?.transaction?.message?.instructions || [];
    for (const ix of outer) {
        if (inspectParsed(ix)) return true;
    }

    const innerGroups = tx?.meta?.innerInstructions || [];
    for (const group of innerGroups) {
        for (const ix of group.instructions || []) {
            if (inspectParsed(ix)) return true;
        }
    }

    return false;
}

async function handlePotentialToxicity(position, logEvent) {
    if (!position.isOpen || position.isExecuting) return;
    const now = Date.now();
    if (position.lastActionAt && now - position.lastActionAt < 1500) return;

    const hasDangerPattern = (logEvent.logs || []).some((line) => /Instruction:\s*(MintTo|MintToChecked|SetAuthority|FreezeAccount|InitializeMint)/i.test(String(line || '')));
    if (!hasDangerPattern) return;

    try {
        const tx = await orchestrator.connection.getParsedTransaction(logEvent.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });
        if (!txHasToxicInstruction(tx, position.mint)) return;

        emit({ type: 'toxicity_detected', ts: new Date().toISOString(), mint: position.mint, signature: logEvent.signature });

        const key = claimIdempotencyKey(position, 'sell', now, `toxicity:${logEvent.signature || 'unknown'}`);
        if (!key) {
            emit({ type: 'idempotency_skip', ts: new Date().toISOString(), mint: position.mint, side: 'sell', source: 'toxicity' });
            return;
        }

        position.lastActionAt = now;
        const currentPriceScaled = computeVirtualPriceScaled(position, position.lastVaultAmount || 1n);
        await closePosition(position, now, 'toxicity', currentPriceScaled);
    } catch (error) {
        position.recentFailures += 1;
        emit({ type: 'toxicity_error', ts: new Date().toISOString(), mint: position.mint, message: error.message });
    }
}

async function onVaultUpdate(position, accountInfo, slot) {
    const decoded = unpackAccount(new PublicKey(position.ammVault), accountInfo, new PublicKey(position.mintProgram));
    const amountRaw = decoded.amount;

    if (position.lastVaultAmount === null) {
        position.lastVaultAmount = amountRaw;
        return;
    }

    const deltaRaw = amountRaw - position.lastVaultAmount;
    position.lastVaultAmount = amountRaw;
    if (deltaRaw === 0n) return;

    const deltaUi = Number(deltaRaw) / Math.pow(10, position.mintDecimals);
    const now = Date.now();
    position.lastSeenAt = now;
    const side = deltaRaw < 0n ? 'buy' : 'sell';

    position.velocityEvents.push({ ts: now, deltaUi: side === 'buy' ? Math.abs(deltaUi) : -Math.abs(deltaUi) });
    const velocityUiPerSec = updateMomentumState(position, now);
    const currentPriceScaled = computeVirtualPriceScaled(position, amountRaw);
    position.lastVaultTickAt = now;

    emit({
        type: 'amm_tick',
        ts: new Date(now).toISOString(),
        mint: position.mint,
        mode: position.mode,
        ammVault: position.ammVault,
        slot,
        side,
        vaultDeltaRaw: deltaRaw.toString(),
        vaultDeltaUi: formatAmount(deltaRaw, position.mintDecimals),
        velocityUiPerSec,
        virtualPrice: formatScaledPrice(currentPriceScaled),
        securityPassed: position.securityPassed,
        momentumPassed: position.momentumPassed,
        positionOpen: position.isOpen
    });

    await maybeExecuteStrategy(position, now, velocityUiPerSec, currentPriceScaled);
}
async function subscribePosition(position) {
    const ammVaultPublicKey = new PublicKey(position.ammVault);

    position.subscriptionId = orchestrator.connection.onAccountChange(
        ammVaultPublicKey,
        async (updatedInfo, context) => {
            try {
                await onVaultUpdate(position, updatedInfo, context.slot);
            } catch (error) {
                emit({ type: 'vault_error', ts: new Date().toISOString(), mint: position.mint, message: error.message });
            }
        },
        COMMITMENT
    );

    position.logsSubscriptionId = orchestrator.connection.onLogs(
        new PublicKey(position.mintProgram),
        async (logs) => {
            if (!logs.err) {
                await handlePotentialToxicity(position, logs);
            }
        },
        COMMITMENT
    );
}

async function initializeTarget({ mint, mode, amountUsd, metadata }) {
    if (!mint || orchestrator.positions.has(mint)) return;

    const position = newPositionState({ mint, mode, amountUsd });

    // Merge metadata first so platform-aware vault resolution can use it.
    if (metadata && typeof metadata === 'object') {
        mergeMetadataForPosition(position, metadata);
    }

    const pending = orchestrator.pendingMetadata.get(mint);
    if (pending) {
        mergeMetadataForPosition(position, pending);
        orchestrator.pendingMetadata.delete(mint);
    }

    const mintPublicKey = new PublicKey(mint);
    const accountInfo = await orchestrator.connection.getAccountInfo(mintPublicKey, COMMITMENT);
    if (!accountInfo) throw new Error(`Mint account ${mint} does not exist.`);

    position.mintProgram = accountInfo.owner.toBase58();
    const mintInfo = await getMint(orchestrator.connection, mintPublicKey, COMMITMENT, accountInfo.owner);
    position.mintDecimals = mintInfo.decimals;
    position.mintSupplyRaw = mintInfo.supply;

    if (orchestrator.wallet) {
        const userAta = await getAssociatedTokenAddress(
            mintPublicKey,
            orchestrator.wallet.publicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        position.userAta = userAta.toBase58();
        const ataInfo = await orchestrator.connection.getAccountInfo(userAta, COMMITMENT);
        position.requiresAtaCreation = !ataInfo;
    } else {
        position.userAta = null;
        position.requiresAtaCreation = true;
    }

    const resolvedAmmVault = await resolveAmmVaultAddress(position);
    position.ammVault = resolvedAmmVault.toBase58();

    const initialVault = await orchestrator.connection.getAccountInfo(resolvedAmmVault, COMMITMENT);
    if (!initialVault) throw new Error(`AMM vault account ${position.ammVault} not found for ${mint}`);
    const decodedInitial = unpackAccount(resolvedAmmVault, initialVault, new PublicKey(position.mintProgram));
    position.lastVaultAmount = decodedInitial.amount;

    await subscribePosition(position);
    orchestrator.positions.set(mint, position);

    emit({
        type: 'target_ready',
        ts: new Date().toISOString(),
        mint,
        mode: position.mode,
        mintDecimals: position.mintDecimals,
        mintProgram: position.mintProgram,
        ammVault: position.ammVault,
        subscriptionId: position.subscriptionId,
        logsSubscriptionId: position.logsSubscriptionId,
        activeTargets: orchestrator.positions.size
    });
}

function mergeMetadata(payload) {
    const mint = payload?.mint || payload?.contractAddress || payload?.tokenAddress || payload?.tokenId;
    if (!mint) return;

    const position = orchestrator.positions.get(mint);
    if (position) {
        mergeMetadataForPosition(position, payload);
        return;
    }

    orchestrator.pendingMetadata.set(mint, {
        ...(orchestrator.pendingMetadata.get(mint) || {}),
        ...payload
    });
}

async function clearAllSubscriptions() {
    for (const position of orchestrator.positions.values()) {
        try {
            if (position.subscriptionId !== null) {
                await orchestrator.connection.removeAccountChangeListener(position.subscriptionId);
            }
        } catch {}
        try {
            if (position.logsSubscriptionId !== null) {
                await orchestrator.connection.removeOnLogsListener(position.logsSubscriptionId);
            }
        } catch {}
        position.subscriptionId = null;
        position.logsSubscriptionId = null;
    }
}

async function triggerReconnect(reason) {
    if (orchestrator.reconnecting) return;
    orchestrator.reconnecting = true;

    emit({ type: 'rpc_reconnect', ts: new Date().toISOString(), stage: 'start', reason, attempt: orchestrator.reconnectAttempts });

    try {
        if (orchestrator.connection) {
            await clearAllSubscriptions();
        }

        orchestrator.connection = createConnection();
        orchestrator.wsHooked = false;
        attachWsCloseHooks();

        for (const position of orchestrator.positions.values()) {
            const vaultKey = new PublicKey(position.ammVault);
            const initialVault = await orchestrator.connection.getAccountInfo(vaultKey, COMMITMENT);
            if (initialVault) {
                const decodedInitial = unpackAccount(vaultKey, initialVault, new PublicKey(position.mintProgram));
                position.lastVaultAmount = decodedInitial.amount;
            }
            await subscribePosition(position);
        }

        orchestrator.reconnectAttempts = 0;
        if (orchestrator.reconnectTimer) {
            clearTimeout(orchestrator.reconnectTimer);
            orchestrator.reconnectTimer = null;
        }

        emit({ type: 'rpc_reconnect', ts: new Date().toISOString(), stage: 'complete', reason, attempt: 0, activeTargets: orchestrator.positions.size });
    } catch (error) {
        orchestrator.reconnectAttempts += 1;
        emit({ type: 'rpc_reconnect', ts: new Date().toISOString(), stage: 'error', reason, attempt: orchestrator.reconnectAttempts, message: error.message });
        scheduleReconnect(`retry_after_error:${reason}`);
    } finally {
        orchestrator.reconnecting = false;
    }
}

function scheduleReconnect(reason) {
    if (orchestrator.reconnecting || orchestrator.reconnectTimer) return;

    const expDelay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, orchestrator.reconnectAttempts));
    const jitter = Math.floor(Math.random() * (RECONNECT_JITTER_MS + 1));
    const delayMs = expDelay + jitter;

    emit({ type: 'rpc_reconnect', ts: new Date().toISOString(), stage: 'scheduled', reason, attempt: orchestrator.reconnectAttempts, delayMs });

    orchestrator.reconnectTimer = setTimeout(async () => {
        orchestrator.reconnectTimer = null;
        await triggerReconnect(reason);
    }, delayMs);
}

function startRpcWatchdog() {
    if (orchestrator.watchdogHandle) {
        clearInterval(orchestrator.watchdogHandle);
    }

    orchestrator.watchdogHandle = setInterval(async () => {
        let disconnected = false;
        try {
            const internal = orchestrator.connection?._rpcWebSocket;
            if (internal && typeof internal.connected === 'boolean') {
                disconnected = !internal.connected;
            }
        } catch {}

        if (disconnected) {
            scheduleReconnect('watchdog_ws_disconnected');
            return;
        }

        const now = Date.now();
        for (const position of orchestrator.positions.values()) {
            const stale = position.lastVaultTickAt > 0 && now - position.lastVaultTickAt > RPC_STALE_MS;
            if (stale && (position.subscriptionId === null || position.logsSubscriptionId === null)) {
                scheduleReconnect(`watchdog_stale:${position.mint}`);
                return;
            }
        }

        try {
            await enforceOpenPositionSafety();
            await pruneIdleFlatTargets();
            await maybePromoteDeferredTarget();
        } catch (error) {
            emit({ type: 'ipc_error', ts: new Date().toISOString(), message: `idle_prune_failed:${error.message}` });
        }
    }, RPC_WATCHDOG_MS);
}

function startIpcServer() {
    const wss = new WebSocketServer({ host: IPC_HOST, port: IPC_PORT });

    wss.on('connection', (socket) => {
        orchestrator.ipcClients.add(socket);

        socket.on('close', () => {
            orchestrator.ipcClients.delete(socket);
        });
        socket.on('error', () => {
            orchestrator.ipcClients.delete(socket);
        });

        socket.on('message', async (raw) => {
            try {
                const msg = JSON.parse(String(raw));

                if (msg.authToken !== IPC_AUTH_TOKEN) {
                    emit({ type: 'ipc_rejected', ts: new Date().toISOString(), reason: 'invalid_auth_token' });
                    return;
                }

                if (msg.type === 'metadata' || msg.type === 'token_metadata') {
                    mergeMetadata(msg.payload || msg);
                    return;
                }

                if (msg.type === 'target_acquired') {
                    const mint = msg.mint || msg.payload?.mint;
                    if (!mint) return;

                    const mode = msg.mode || 'paper';

                    // Hard intake pause at max open slots: keep only latest token, no queue.
                    if (mode !== 'live' && getOpenPositionsCount() >= MAX_OPEN_POSITIONS) {
                        deferLatestTarget({
                            mint,
                            mode,
                            amountUsd: msg.amountUsd,
                            metadata: msg.payload || {}
                        });
                        return;
                    }

                    if (!isValidMintAddress(mint)) {
                        emitTargetRejectedThrottled({
                            type: 'target_rejected',
                            ts: new Date().toISOString(),
                            mint,
                            mode,
                            reason: 'invalid_mint_format',
                            activeTargets: orchestrator.positions.size,
                            maxActiveTargets: MAX_ACTIVE_TARGETS
                        });
                        return;
                    }

                    if (orchestrator.positions.has(mint) || orchestrator.pendingTargetInitializations.has(mint)) {
                        emit({ type: 'target_duplicate', ts: new Date().toISOString(), mint, mode });
                        return;
                    }

                    const admission = shouldAcceptNewTarget(mode);
                    if (!admission.ok) {
                        emitTargetRejectedThrottled({
                            type: 'target_rejected',
                            ts: new Date().toISOString(),
                            mint,
                            mode,
                            reason: admission.reason,
                            activeTargets: totalReservedTargetSlots(),
                            maxActiveTargets: MAX_ACTIVE_TARGETS,
                            availableUsd: Number(capitalState.availableUsd.toFixed(2)),
                            plannedUsd: Number((admission.plannedUsd || 0).toFixed(2))
                        });
                        return;
                    }

                    if (admission.evictMint && orchestrator.positions.has(admission.evictMint)) {
                        const evicted = orchestrator.positions.get(admission.evictMint);
                        if (evicted && !evicted.isOpen && !evicted.isExecuting) {
                            await cleanupPosition(evicted, admission.evictReason || 'capacity_rebalance');
                        }
                    }

                    orchestrator.pendingTargetInitializations.add(mint);

                    try {
                        await initializeTarget({
                            mint,
                            mode,
                            amountUsd: msg.amountUsd,
                            metadata: msg.payload || {}
                        });
                    } finally {
                        orchestrator.pendingTargetInitializations.delete(mint);
                    }
                }
            } catch (error) {
                emit({ type: 'ipc_error', ts: new Date().toISOString(), message: error.message });
            }
        });
    });

    status(`IPC server listening on ws://${IPC_HOST}:${IPC_PORT}`);
}

async function start() {
    ensureSessionLogging();
    startCliRenderer();
    orchestrator.connection = createConnection();
    attachWsCloseHooks();
    orchestrator.wallet = parseWalletFromEnv(WALLET_SECRET_KEY);

    startIpcServer();
    startRpcWatchdog();

    if (BOOTSTRAP_TARGET_MINT) {
        await initializeTarget({
            mint: BOOTSTRAP_TARGET_MINT,
            mode: BOOTSTRAP_MODE,
            amountUsd: 100,
            metadata: orchestrator.pendingMetadata.get(BOOTSTRAP_TARGET_MINT) || {}
        });
    }

    emit({
        type: 'ready',
        ts: new Date().toISOString(),
        rpc: { http: STAKED_RPC_HTTP_URL, ws: STAKED_RPC_WS_URL },
        executionEnabled: EXECUTION_ENABLED,
        walletConfigured: !!orchestrator.wallet,
        activeTargets: orchestrator.positions.size,
        strategy: {
            minBuyVelocity: MIN_BUY_VELOCITY,
            trailingStopDrawdown: TRAILING_STOP_DRAWDOWN,
            openStaleExitMs: OPEN_STALE_EXIT_MS,
            lockedProfitTriggerPct: LOCKED_PROFIT_TRIGGER_PCT,
            lockedProfitFloorPct: LOCKED_PROFIT_FLOOR_PCT,
            maxTop10Pct: MAX_TOP10_PCT,
            maxBundlersPct: MAX_BUNDLERS_PCT,
            maxDevPct: MAX_DEV_PCT,
            requireLpBurn: REQUIRE_LP_BURN
        }
    });
}

start().catch((error) => {
    finalizeSession('startup_failed');
    stopCliRenderer();
    process.stderr.write(`Startup failed: ${error.message}\n`);
    process.exitCode = 1;
});

process.on('SIGINT', () => {
    finalizeSession('sigint');
    stopCliRenderer();
    process.exit(130);
});

process.on('SIGTERM', () => {
    finalizeSession('sigterm');
    stopCliRenderer();
    process.exit(143);
});

process.on('exit', () => {
    finalizeSession('process_exit');
    stopCliRenderer();
});
