const {
    AddressLookupTableAccount,
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    TransactionInstruction,
    VersionedTransaction
} = require('@solana/web3.js');
const { getMint, unpackAccount } = require('@solana/spl-token');
const { WebSocketServer } = require('ws');

const TEST_TARGET_TOKEN_MINT = 'EAEdoRkGNyYqFsY5ZpiCmE9uauMVxtH1FKiNrQL5pump';

const STAKED_RPC_HTTP_URL = process.env.STAKED_RPC_HTTP_URL || process.env.HTTP_URL || 'https://mainnet.helius-rpc.com/?api-key=bd671ad8-382f-41fd-9d68-28ee7e46872b';
const STAKED_RPC_WS_URL = process.env.STAKED_RPC_WS_URL || process.env.WS_URL || 'wss://mainnet.helius-rpc.com/?api-key=bd671ad8-382f-41fd-9d68-28ee7e46872b';
const TARGET_TOKEN_MINT = process.env.TARGET_TOKEN_MINT || TEST_TARGET_TOKEN_MINT;
const COMMITMENT = process.env.COMMITMENT || 'processed';

const IPC_HOST = process.env.IPC_HOST || '127.0.0.1';
const IPC_PORT = Number(process.env.IPC_PORT || 8080);
const IPC_AUTH_TOKEN = process.env.IPC_AUTH_TOKEN || 'local-dev-ipc-token';
const RPC_WATCHDOG_MS = Number(process.env.RPC_WATCHDOG_MS || 8000);
const RPC_STALE_MS = Number(process.env.RPC_STALE_MS || 45000);
const RECONNECT_BASE_MS = Number(process.env.RECONNECT_BASE_MS || 1000);
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS || 30000);
const RECONNECT_JITTER_MS = Number(process.env.RECONNECT_JITTER_MS || 600);

const IDEMPOTENCY_WINDOW_MS = Number(process.env.IDEMPOTENCY_WINDOW_MS || 1500);
const IDEMPOTENCY_KEY_TTL_MS = Number(process.env.IDEMPOTENCY_KEY_TTL_MS || 60000);

const EXECUTION_ENABLED = process.env.EXECUTION_ENABLED === '1';
const WALLET_SECRET_KEY = process.env.WALLET_SECRET_KEY || '';
const QUOTE_API = process.env.JUP_QUOTE_API || 'https://quote-api.jup.ag/v6/quote';
const SWAP_API = process.env.JUP_SWAP_INSTRUCTIONS_API || 'https://quote-api.jup.ag/v6/swap-instructions';
const INPUT_MINT_BUY = process.env.INPUT_MINT_BUY || 'So11111111111111111111111111111111111111112';
const BASE_BUY_AMOUNT_LAMPORTS = BigInt(process.env.BUY_AMOUNT_LAMPORTS || 10000000);
const STRICT_SLIPPAGE_BPS = Number(process.env.STRICT_SLIPPAGE_BPS || 50);
const SELL_SLIPPAGE_BPS = Number(process.env.SELL_SLIPPAGE_BPS || 50);

const MAX_TOP10_PCT = Number(process.env.MAX_TOP10_PCT || 25);
const MAX_BUNDLERS_PCT = Number(process.env.MAX_BUNDLERS_PCT || 20);
const MAX_DEV_PCT = Number(process.env.MAX_DEV_PCT || 8);
const REQUIRE_LP_BURN = process.env.REQUIRE_LP_BURN !== '0';
const MIN_BUY_VELOCITY = Number(process.env.MIN_BUY_VELOCITY || 0.02);
const SELL_VELOCITY_TRIGGER = Number(process.env.SELL_VELOCITY_TRIGGER || -0.03);
const VELOCITY_WINDOW_MS = Number(process.env.VELOCITY_WINDOW_MS || 15000);

const DYNAMIC_FEE_WINDOW = Number(process.env.DYNAMIC_FEE_WINDOW || 150);
const BASE_CONTENTION_MULTIPLIER = Number(process.env.BASE_CONTENTION_MULTIPLIER || 1.35);
const CONTENTION_MULTIPLIER_CAP = Number(process.env.CONTENTION_MULTIPLIER_CAP || 6.0);
const COMPUTE_LIMIT_BUFFER_PCT = Number(process.env.COMPUTE_LIMIT_BUFFER_PCT || 12);

let connection = null;

const state = {
    mint: TARGET_TOKEN_MINT,
    mintDecimals: 0,
    mintProgram: null,
    ammVault: process.env.AMM_VAULT_ADDRESS || null,
    lastVaultAmount: null,
    ammSide: null,
    velocityEvents: [],
    recentFailures: 0,
    metadata: {
        top10Pct: null,
        bundlersPct: null,
        devPct: null,
        marketCap: null,
        lpBurned: null,
        platform: null,
        sourceHost: null,
        updatedAt: null
    },
    securityPassed: false,
    momentumPassed: false,
    position: {
        isOpen: false,
        isExecuting: false,
        entrySignature: null,
        entrySlot: null,
        entryAmountRaw: null,
        entryMarketCap: null,
        peakMarketCap: null
    },
    lastActionAt: 0,
    subscriptionId: null,
    logsSubscriptionId: null,
    velocitySamples: [],
    lastVaultTickAt: 0,
    reconnecting: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    watchdogHandle: null,
    wsHooked: false,
    status: 'booting',
    idempotencyKeys: new Map()
};

let wallet = null;

function status(message) {
    process.stderr.write(`${message}\n`);
}

function emit(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function pruneIdempotencyKeys(now) {
    for (const [key, ts] of state.idempotencyKeys.entries()) {
        if (now - ts > IDEMPOTENCY_KEY_TTL_MS) {
            state.idempotencyKeys.delete(key);
        }
    }
}

function buildIdempotencyKey(side, now, source) {
    const window = Math.floor(now / IDEMPOTENCY_WINDOW_MS);
    const openFlag = state.position.isOpen ? 'open' : 'flat';
    return `${side}:${source}:${window}:${openFlag}`;
}

function claimIdempotencyKey(side, now, source) {
    pruneIdempotencyKeys(now);
    const key = buildIdempotencyKey(side, now, source);
    if (state.idempotencyKeys.has(key)) {
        return null;
    }
    state.idempotencyKeys.set(key, now);
    return key;
}

function createConnection() {
    return new Connection(STAKED_RPC_HTTP_URL, {
        wsEndpoint: STAKED_RPC_WS_URL,
        commitment: COMMITMENT
    });
}

function attachWsCloseHooks() {
    if (!connection || state.wsHooked) return;

    const internal = connection._rpcWebSocket;
    if (!internal || typeof internal.on !== 'function') return;

    try {
        internal.on('close', () => {
            scheduleReconnect('ws_close');
        });
        internal.on('error', () => {
            scheduleReconnect('ws_error');
        });
        state.wsHooked = true;
    } catch {
        // Best effort only for internal socket hooks.
    }
}

function parseWalletFromEnv(secretKeyText) {
    if (!secretKeyText) return null;

    try {
        if (secretKeyText.trim().startsWith('[')) {
            const arr = JSON.parse(secretKeyText);
            return Keypair.fromSecretKey(Uint8Array.from(arr));
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
    const str = String(value).trim();
    if (!str) return null;
    const match = str.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    return Number(match[0]);
}

function parseMarketCapLike(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;

    const cleaned = String(value)
        .trim()
        .replace(/[$,\s]/g, '')
        .toUpperCase();

    if (!cleaned) return null;

    const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/);
    if (!match) return null;

    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;

    const unit = match[2] || '';
    const multipliers = {
        '': 1,
        K: 1_000,
        M: 1_000_000,
        B: 1_000_000_000,
        T: 1_000_000_000_000
    };

    return base * (multipliers[unit] || 1);
}

function parseBooleanLike(value) {
    if (typeof value === 'boolean') return value;
    if (value === null || value === undefined) return null;
    const str = String(value).trim().toLowerCase();
    if (!str) return null;
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

    if (decimals === 0) {
        return `${negative ? '-' : ''}${whole.toString()}`;
    }

    const fractionPadded = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    if (!fractionPadded) {
        return `${negative ? '-' : ''}${whole.toString()}`;
    }

    return `${negative ? '-' : ''}${whole.toString()}.${fractionPadded}`;
}

async function resolveAmmVaultAddress(mintPublicKey) {
    if (state.ammVault) {
        return new PublicKey(state.ammVault);
    }

    // Heuristic fallback: on high-velocity meme pairs, the largest token account is commonly the active AMM vault.
    const largest = await connection.getTokenLargestAccounts(mintPublicKey, COMMITMENT);
    const first = largest?.value?.find((x) => x?.address);
    if (!first) {
        throw new Error('Unable to resolve AMM vault address. Set AMM_VAULT_ADDRESS explicitly.');
    }

    state.ammVault = first.address.toBase58();
    return first.address;
}

async function validateMintAndResolveAmm() {
    const mintPublicKey = new PublicKey(TARGET_TOKEN_MINT);
    const accountInfo = await connection.getAccountInfo(mintPublicKey, COMMITMENT);
    if (!accountInfo) {
        throw new Error(`Mint account ${TARGET_TOKEN_MINT} does not exist.`);
    }

    state.mintProgram = accountInfo.owner.toBase58();

    const mint = await getMint(connection, mintPublicKey, COMMITMENT, accountInfo.owner);
    state.mintDecimals = mint.decimals;

    const ammVault = await resolveAmmVaultAddress(mintPublicKey);
    return ammVault;
}

function updateSecurityState() {
    const top10 = parsePercentLike(state.metadata.top10Pct);
    const bundlers = parsePercentLike(state.metadata.bundlersPct);
    const dev = parsePercentLike(state.metadata.devPct);

    state.metadata.top10Pct = top10;
    state.metadata.bundlersPct = bundlers;
    state.metadata.devPct = dev;

    const top10Ok = top10 !== null && top10 <= MAX_TOP10_PCT;
    const bundlersOk = bundlers !== null && bundlers <= MAX_BUNDLERS_PCT;
    const devOk = dev !== null && dev <= MAX_DEV_PCT;
    const lpOk = REQUIRE_LP_BURN ? state.metadata.lpBurned === true : true;

    state.securityPassed = top10Ok && bundlersOk && devOk && lpOk;
}

function pruneVelocity(now) {
    state.velocityEvents = state.velocityEvents.filter((x) => now - x.ts <= VELOCITY_WINDOW_MS);
}

function computeVelocity(now) {
    pruneVelocity(now);
    if (!state.velocityEvents.length) return 0;
    const seconds = Math.max(1, VELOCITY_WINDOW_MS / 1000);
    const sum = state.velocityEvents.reduce((acc, x) => acc + x.deltaUi, 0);
    return sum / seconds;
}

function updateMomentumState(now) {
    const v = computeVelocity(now);
    state.velocitySamples.push({ ts: now, velocity: v });
    state.velocitySamples = state.velocitySamples.filter((x) => now - x.ts <= VELOCITY_WINDOW_MS);
    state.momentumPassed = v >= MIN_BUY_VELOCITY;
    return v;
}

function isVelocityExhausted(currentVelocity, now) {
    const samples = state.velocitySamples.filter((x) => now - x.ts <= VELOCITY_WINDOW_MS);
    if (!samples.length) return false;

    const peakVelocity = samples.reduce((max, x) => Math.max(max, x.velocity), Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(peakVelocity) || peakVelocity <= 0) return false;

    return currentVelocity <= peakVelocity * 0.5;
}

function shouldTriggerTrailingStop(currentMarketCap) {
    if (!state.position.isOpen) return false;
    if (!Number.isFinite(currentMarketCap) || currentMarketCap <= 0) return false;

    if (!Number.isFinite(state.position.peakMarketCap) || state.position.peakMarketCap <= 0) {
        state.position.peakMarketCap = currentMarketCap;
        return false;
    }

    if (currentMarketCap > state.position.peakMarketCap) {
        state.position.peakMarketCap = currentMarketCap;
        return false;
    }

    const drawdown = (state.position.peakMarketCap - currentMarketCap) / state.position.peakMarketCap;
    return drawdown >= 0.15;
}

async function calculateDynamicCuPrice() {
    const feeSamples = await connection.getRecentPrioritizationFees();
    const samples = (feeSamples || [])
        .slice(-DYNAMIC_FEE_WINDOW)
        .map((x) => Number(x.prioritizationFee || 0))
        .filter((x) => Number.isFinite(x) && x >= 0)
        .sort((a, b) => a - b);

    const median = samples.length ? samples[Math.floor(samples.length / 2)] : 0;

    const contentionDetected = state.recentFailures > 0;
    const multiplier = contentionDetected
        ? Math.min(CONTENTION_MULTIPLIER_CAP, Math.pow(BASE_CONTENTION_MULTIPLIER, Math.min(6, state.recentFailures)))
        : 1;

    return {
        medianMicroLamports: median,
        finalMicroLamports: Math.max(1, Math.floor(median * multiplier) || 1),
        contentionDetected,
        multiplier
    };
}

function decodeJupiterInstruction(rawIx) {
    if (!rawIx) return null;
    return new TransactionInstruction({
        programId: new PublicKey(rawIx.programId),
        keys: (rawIx.accounts || []).map((k) => ({
            pubkey: new PublicKey(k.pubkey),
            isSigner: !!k.isSigner,
            isWritable: !!k.isWritable
        })),
        data: Buffer.from(rawIx.data || '', 'base64')
    });
}

async function loadAltAccounts(addresses) {
    if (!Array.isArray(addresses) || !addresses.length) return [];

    const out = [];
    for (const addr of addresses) {
        try {
            const res = await connection.getAddressLookupTable(new PublicKey(addr));
            if (res?.value) {
                out.push(
                    new AddressLookupTableAccount({
                        key: new PublicKey(addr),
                        state: res.value.state
                    })
                );
            }
        } catch {}
    }
    return out;
}

async function fetchJupiterQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
    const url = new URL(QUOTE_API);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', amountRaw.toString());
    url.searchParams.set('slippageBps', String(slippageBps));
    url.searchParams.set('onlyDirectRoutes', 'false');

    const res = await fetch(url.toString());
    if (!res.ok) {
        throw new Error(`Quote failed (${res.status})`);
    }

    return res.json();
}

async function fetchJupiterSwapInstructions(quoteResponse) {
    const res = await fetch(SWAP_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            useSharedAccounts: true,
            dynamicComputeUnitLimit: false,
            quoteResponse
        })
    });

    if (!res.ok) {
        throw new Error(`Swap-instructions failed (${res.status})`);
    }

    return res.json();
}

async function simulateAndBuildFinalTx({ payer, ixs, altAccounts, cuPrice }) {
    const { blockhash } = await connection.getLatestBlockhash(COMMITMENT);

    const provisionalIxs = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...ixs
    ];

    const provisionalMsg = new (require('@solana/web3.js').TransactionMessage)({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: provisionalIxs
    }).compileToV0Message(altAccounts);

    const provisionalTx = new VersionedTransaction(provisionalMsg);
    provisionalTx.sign([wallet]);

    const sim = await connection.simulateTransaction(provisionalTx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: COMMITMENT
    });

    if (sim.value.err) {
        throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
    }

    const consumed = Number(sim.value.unitsConsumed || 300000);
    const finalUnits = Math.max(120000, Math.floor(consumed * (1 + COMPUTE_LIMIT_BUFFER_PCT / 100)));

    const { blockhash: finalHash, lastValidBlockHeight } = await connection.getLatestBlockhash(COMMITMENT);

    const finalIxs = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: finalUnits }),
        ...ixs
    ];

    const finalMsg = new (require('@solana/web3.js').TransactionMessage)({
        payerKey: payer,
        recentBlockhash: finalHash,
        instructions: finalIxs
    }).compileToV0Message(altAccounts);

    const tx = new VersionedTransaction(finalMsg);
    tx.sign([wallet]);

    return {
        tx,
        unitsConsumed: consumed,
        computeUnitLimit: finalUnits,
        lastValidBlockHeight,
        recentBlockhash: finalHash
    };
}

async function submitSwap({ side, amountRaw, slippageBps }) {
    if (!EXECUTION_ENABLED) {
        emit({
            type: 'execution_skipped',
            ts: new Date().toISOString(),
            reason: 'EXECUTION_ENABLED is not set',
            side,
            amountRaw: amountRaw.toString(),
            mint: TARGET_TOKEN_MINT
        });
        return null;
    }

    if (!wallet) {
        throw new Error('Wallet is not configured. Set WALLET_SECRET_KEY to enable execution.');
    }

    const inputMint = side === 'buy' ? INPUT_MINT_BUY : TARGET_TOKEN_MINT;
    const outputMint = side === 'buy' ? TARGET_TOKEN_MINT : INPUT_MINT_BUY;

    const quote = await fetchJupiterQuote({
        inputMint,
        outputMint,
        amountRaw,
        slippageBps
    });

    const swapData = await fetchJupiterSwapInstructions(quote);

    const swapIxs = [
        decodeJupiterInstruction(swapData.computeBudgetInstructions?.[0]),
        decodeJupiterInstruction(swapData.setupInstructions?.[0]),
        decodeJupiterInstruction(swapData.swapInstruction),
        decodeJupiterInstruction(swapData.cleanupInstruction)
    ].filter(Boolean);

    if (!swapIxs.length) {
        throw new Error('No swap instructions returned by Jupiter.');
    }

    const altAccounts = await loadAltAccounts(swapData.addressLookupTableAddresses || []);

    const fee = await calculateDynamicCuPrice();

    const built = await simulateAndBuildFinalTx({
        payer: wallet.publicKey,
        ixs: swapIxs,
        altAccounts,
        cuPrice: fee.finalMicroLamports
    });

    const signature = await connection.sendRawTransaction(built.tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2
    });

    const confirmation = await connection.confirmTransaction(
        {
            signature,
            blockhash: built.recentBlockhash,
            lastValidBlockHeight: built.lastValidBlockHeight
        },
        COMMITMENT
    );

    if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    emit({
        type: 'execution',
        ts: new Date().toISOString(),
        side,
        signature,
        mint: TARGET_TOKEN_MINT,
        computeUnitsConsumed: built.unitsConsumed,
        computeUnitLimit: built.computeUnitLimit,
        cuPriceMicroLamports: fee.finalMicroLamports,
        cuMedianMicroLamports: fee.medianMicroLamports,
        contentionDetected: fee.contentionDetected,
        contentionMultiplier: fee.multiplier,
        slippageBps
    });

    state.recentFailures = 0;

    return signature;
}

async function maybeExecuteStrategy(now, velocityUiPerSec) {
    if (state.position.isExecuting) return;
    if (now - state.lastActionAt < 3000) return;

    updateSecurityState();
    const currentMarketCap = parseMarketCapLike(state.metadata.marketCap);

    if (!state.position.isOpen) {
        if (state.securityPassed && state.momentumPassed) {
            const idempotencyKey = claimIdempotencyKey('buy', now, 'strategy');
            if (!idempotencyKey) {
                emit({
                    type: 'idempotency_skip',
                    ts: new Date().toISOString(),
                    side: 'buy',
                    source: 'strategy'
                });
                return;
            }

            state.position.isExecuting = true;
            try {
                const sig = await submitSwap({
                    side: 'buy',
                    amountRaw: BASE_BUY_AMOUNT_LAMPORTS,
                    slippageBps: STRICT_SLIPPAGE_BPS
                });

                if (sig) {
                    state.position.isOpen = true;
                    state.position.entrySignature = sig;
                    state.position.entrySlot = null;
                    state.position.entryAmountRaw = BASE_BUY_AMOUNT_LAMPORTS.toString();
                    state.position.entryMarketCap = currentMarketCap;
                    state.position.peakMarketCap = currentMarketCap;
                    state.position.idempotencyKey = idempotencyKey;
                    state.lastActionAt = now;
                }
            } catch (error) {
                state.recentFailures += 1;
                emit({
                    type: 'execution_error',
                    ts: new Date().toISOString(),
                    side: 'buy',
                    message: error.message
                });
            } finally {
                state.position.isExecuting = false;
            }
        }
        return;
    }

    const trailingStopHit = shouldTriggerTrailingStop(currentMarketCap);
    const velocityExhausted = isVelocityExhausted(velocityUiPerSec, now);
    const shouldSell = trailingStopHit || velocityExhausted;

    if (shouldSell) {
        const idempotencyKey = claimIdempotencyKey('sell', now, 'strategy');
        if (!idempotencyKey) {
            emit({
                type: 'idempotency_skip',
                ts: new Date().toISOString(),
                side: 'sell',
                source: 'strategy'
            });
            return;
        }

        state.position.isExecuting = true;
        try {
            const amountRaw = 1000000n;
            const sig = await submitSwap({
                side: 'sell',
                amountRaw,
                slippageBps: SELL_SLIPPAGE_BPS
            });

            if (sig) {
                state.position.isOpen = false;
                state.position.entrySignature = null;
                state.position.entrySlot = null;
                state.position.entryAmountRaw = null;
                state.position.entryMarketCap = null;
                state.position.peakMarketCap = null;
                state.position.idempotencyKey = idempotencyKey;
                state.position.isExecuting = false;
                state.lastActionAt = now;
            }
        } catch (error) {
            state.recentFailures += 1;
            emit({
                type: 'execution_error',
                ts: new Date().toISOString(),
                side: 'sell',
                message: error.message
            });
        } finally {
            state.position.isExecuting = false;
        }
    }
}

async function onVaultUpdate(accountInfo, slot) {
    const decoded = unpackAccount(new PublicKey(state.ammVault), accountInfo, new PublicKey(state.mintProgram));
    const amountRaw = decoded.amount;

    if (state.lastVaultAmount === null) {
        state.lastVaultAmount = amountRaw;
        return;
    }

    const deltaRaw = amountRaw - state.lastVaultAmount;
    state.lastVaultAmount = amountRaw;

    if (deltaRaw === 0n) return;

    const deltaUi = Number(deltaRaw) / Math.pow(10, state.mintDecimals);
    const now = Date.now();

    // Vault decreases when token leaves pool (user buys token), increases when token enters pool (user sells token).
    const side = deltaRaw < 0n ? 'buy' : 'sell';

    state.ammSide = side;
    state.velocityEvents.push({ ts: now, deltaUi: side === 'buy' ? Math.abs(deltaUi) : -Math.abs(deltaUi) });

    const velocityUiPerSec = updateMomentumState(now);
    state.lastVaultTickAt = now;

    emit({
        type: 'amm_tick',
        ts: new Date(now).toISOString(),
        mint: TARGET_TOKEN_MINT,
        ammVault: state.ammVault,
        slot,
        side,
        vaultDeltaRaw: deltaRaw.toString(),
        vaultDeltaUi: formatAmount(deltaRaw, state.mintDecimals),
        velocityUiPerSec,
        securityPassed: state.securityPassed,
        momentumPassed: state.momentumPassed,
        positionOpen: state.position.isOpen
    });

    await maybeExecuteStrategy(now, velocityUiPerSec);
}

function mergeMetadata(input) {
    if (!input || typeof input !== 'object') return;

    const mint = input.mint || input.contractAddress || input.tokenAddress || input.tokenId;
    if (mint !== TARGET_TOKEN_MINT) return;

    state.metadata.top10Pct = parsePercentLike(input.top10Pct ?? input.topHolders ?? input.topHoldersPct);
    state.metadata.bundlersPct = parsePercentLike(input.bundlersPct ?? input.bundlePct ?? input.bundlePercentage);
    state.metadata.devPct = parsePercentLike(input.devPct ?? input.insiderPct ?? input.devPercentage);
    state.metadata.marketCap = parseMarketCapLike(input.marketCap ?? input.mc ?? input.market_cap);
    state.metadata.lpBurned = parseBooleanLike(input.lpBurned ?? input.lpBurnStatus ?? input.lpBurn);
    state.metadata.platform = input.platform || state.metadata.platform;
    state.metadata.sourceHost = input.sourceHost || state.metadata.sourceHost;
    state.metadata.updatedAt = Date.now();

    updateSecurityState();

    emit({
        type: 'metadata',
        ts: new Date().toISOString(),
        mint: TARGET_TOKEN_MINT,
        metadata: state.metadata,
        securityPassed: state.securityPassed
    });
}

function txHasToxicInstruction(tx) {
    const dangerous = new Set(['mintTo', 'mintToChecked', 'setAuthority', 'freezeAccount', 'initializeMint', 'initializeMint2']);

    const inspectParsed = (parsedIx) => {
        if (!parsedIx || !parsedIx.parsed) return false;

        const type = parsedIx.parsed.type;
        if (!dangerous.has(type)) return false;

        const info = parsedIx.parsed.info || {};
        const candidateMint = info.mint || info.account || '';
        return candidateMint === TARGET_TOKEN_MINT;
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

async function handlePotentialToxicity(logEvent) {
    if (!state.position.isOpen) return;
    if (state.position.isExecuting) return;
    const now = Date.now();
    if (state.lastActionAt && now - state.lastActionAt < 1500) return;

    const hasDangerPattern = (logEvent.logs || []).some((line) =>
        /Instruction:\s*(MintTo|MintToChecked|SetAuthority|FreezeAccount|InitializeMint)/i.test(String(line || ''))
    );
    if (!hasDangerPattern) return;

    try {
        const tx = await connection.getParsedTransaction(logEvent.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: COMMITMENT
        });

        if (!txHasToxicInstruction(tx)) return;

        emit({
            type: 'toxicity_detected',
            ts: new Date().toISOString(),
            mint: TARGET_TOKEN_MINT,
            signature: logEvent.signature
        });

        const idempotencyKey = claimIdempotencyKey('sell', now, `toxicity:${logEvent.signature || 'unknown'}`);
        if (!idempotencyKey) {
            emit({
                type: 'idempotency_skip',
                ts: new Date().toISOString(),
                side: 'sell',
                source: 'toxicity'
            });
            return;
        }

        state.position.isExecuting = true;
        const sig = await submitSwap({
            side: 'sell',
            amountRaw: 1000000n,
            slippageBps: SELL_SLIPPAGE_BPS
        });

        if (sig) {
            state.position.isOpen = false;
            state.position.entrySignature = null;
            state.position.entrySlot = null;
            state.position.entryAmountRaw = null;
            state.position.entryMarketCap = null;
            state.position.peakMarketCap = null;
            state.position.idempotencyKey = idempotencyKey;
            state.position.isExecuting = false;
            state.lastActionAt = Date.now();
        }
    } catch (error) {
        state.recentFailures += 1;
        emit({
            type: 'toxicity_error',
            ts: new Date().toISOString(),
            message: error.message
        });
    } finally {
        state.position.isExecuting = false;
    }
}

function startIpcServer() {
    const wss = new WebSocketServer({ host: IPC_HOST, port: IPC_PORT });

    wss.on('connection', (socket) => {
        socket.on('message', (raw) => {
            try {
                const msg = JSON.parse(String(raw));

                if (msg.authToken !== IPC_AUTH_TOKEN) {
                    emit({
                        type: 'ipc_rejected',
                        ts: new Date().toISOString(),
                        reason: 'invalid_auth_token'
                    });
                    return;
                }

                if (msg.type === 'metadata' || msg.type === 'token_metadata') {
                    mergeMetadata(msg.payload || msg);
                }
            } catch (error) {
                emit({
                    type: 'ipc_error',
                    ts: new Date().toISOString(),
                    message: error.message
                });
            }
        });
    });

    status(`IPC server listening on ws://${IPC_HOST}:${IPC_PORT}`);
}

async function clearSubscriptions() {
    if (state.subscriptionId !== null) {
        try {
            await connection.removeAccountChangeListener(state.subscriptionId);
        } catch {}
        state.subscriptionId = null;
    }

    if (state.logsSubscriptionId !== null) {
        try {
            await connection.removeOnLogsListener(state.logsSubscriptionId);
        } catch {}
        state.logsSubscriptionId = null;
    }
}

async function subscribeRuntime(ammVaultPublicKey) {
    state.subscriptionId = connection.onAccountChange(
        ammVaultPublicKey,
        async (updatedInfo, context) => {
            try {
                await onVaultUpdate(updatedInfo, context.slot);
            } catch (error) {
                emit({
                    type: 'vault_error',
                    ts: new Date().toISOString(),
                    message: error.message
                });
            }
        },
        COMMITMENT
    );

    state.logsSubscriptionId = connection.onLogs(
        new PublicKey(state.mintProgram),
        async (logs, context) => {
            if (logs.err) return;
            await handlePotentialToxicity(logs, context);
        },
        COMMITMENT
    );
}

async function triggerReconnect(reason) {
    if (state.reconnecting) return;
    state.reconnecting = true;

    emit({
        type: 'rpc_reconnect',
        ts: new Date().toISOString(),
        stage: 'start',
        reason,
        attempt: state.reconnectAttempts
    });

    try {
        if (connection) {
            await clearSubscriptions();
        }

        connection = createConnection();
        state.wsHooked = false;
        attachWsCloseHooks();

        const ammVaultPublicKey = new PublicKey(state.ammVault);
        const initialVault = await connection.getAccountInfo(ammVaultPublicKey, COMMITMENT);
        if (initialVault) {
            const decodedInitial = unpackAccount(ammVaultPublicKey, initialVault, new PublicKey(state.mintProgram));
            state.lastVaultAmount = decodedInitial.amount;
        }

        await subscribeRuntime(ammVaultPublicKey);
        state.reconnectAttempts = 0;
        if (state.reconnectTimer) {
            clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
        }

        emit({
            type: 'rpc_reconnect',
            ts: new Date().toISOString(),
            stage: 'complete',
            reason,
            attempt: 0,
            subscriptionId: state.subscriptionId,
            logsSubscriptionId: state.logsSubscriptionId
        });
    } catch (error) {
        state.reconnectAttempts += 1;
        emit({
            type: 'rpc_reconnect',
            ts: new Date().toISOString(),
            stage: 'error',
            reason,
            attempt: state.reconnectAttempts,
            message: error.message
        });
        scheduleReconnect(`retry_after_error:${reason}`);
    } finally {
        state.reconnecting = false;
    }
}

function scheduleReconnect(reason) {
    if (state.reconnecting) return;
    if (state.reconnectTimer) return;

    const expDelay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, state.reconnectAttempts));
    const jitter = Math.floor(Math.random() * (RECONNECT_JITTER_MS + 1));
    const delayMs = expDelay + jitter;

    emit({
        type: 'rpc_reconnect',
        ts: new Date().toISOString(),
        stage: 'scheduled',
        reason,
        attempt: state.reconnectAttempts,
        delayMs
    });

    state.reconnectTimer = setTimeout(async () => {
        state.reconnectTimer = null;
        await triggerReconnect(reason);
    }, delayMs);
}

function startRpcWatchdog() {
    if (state.watchdogHandle) {
        clearInterval(state.watchdogHandle);
    }

    state.watchdogHandle = setInterval(() => {
        const now = Date.now();
        const stale = state.lastVaultTickAt > 0 && now - state.lastVaultTickAt > RPC_STALE_MS;

        let disconnected = false;
        try {
            const internal = connection?._rpcWebSocket;
            if (internal && typeof internal.connected === 'boolean') {
                disconnected = !internal.connected;
            }
        } catch {}

        if (disconnected) {
            scheduleReconnect('watchdog_ws_disconnected');
            return;
        }

        if (stale && (state.subscriptionId === null || state.logsSubscriptionId === null)) {
            scheduleReconnect('watchdog_stale_or_missing_subscriptions');
        }
    }, RPC_WATCHDOG_MS);
}

async function start() {
    connection = createConnection();
    attachWsCloseHooks();

    wallet = parseWalletFromEnv(WALLET_SECRET_KEY);

    const ammVaultPublicKey = await validateMintAndResolveAmm();
    state.ammVault = ammVaultPublicKey.toBase58();

    const initialVault = await connection.getAccountInfo(ammVaultPublicKey, COMMITMENT);
    if (!initialVault) {
        throw new Error(`AMM vault account ${state.ammVault} not found`);
    }

    const decodedInitial = unpackAccount(ammVaultPublicKey, initialVault, new PublicKey(state.mintProgram));
    state.lastVaultAmount = decodedInitial.amount;

    await subscribeRuntime(ammVaultPublicKey);
    startRpcWatchdog();

    startIpcServer();

    emit({
        type: 'ready',
        ts: new Date().toISOString(),
        mint: TARGET_TOKEN_MINT,
        mintDecimals: state.mintDecimals,
        mintProgram: state.mintProgram,
        ammVault: state.ammVault,
        subscriptionId: state.subscriptionId,
        logsSubscriptionId: state.logsSubscriptionId,
        executionEnabled: EXECUTION_ENABLED,
        walletConfigured: !!wallet,
        strategy: {
            minBuyVelocity: MIN_BUY_VELOCITY,
            sellVelocityTrigger: SELL_VELOCITY_TRIGGER,
            maxTop10Pct: MAX_TOP10_PCT,
            maxBundlersPct: MAX_BUNDLERS_PCT,
            maxDevPct: MAX_DEV_PCT,
            requireLpBurn: REQUIRE_LP_BURN,
            strictSlippageBps: STRICT_SLIPPAGE_BPS
        }
    });
}

start().catch((error) => {
    process.stderr.write(`Startup failed: ${error.message}\n`);
    process.exitCode = 1;
});
