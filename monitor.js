const { Connection, PublicKey } = require('@solana/web3.js');
const { getMint, unpackAccount } = require('@solana/spl-token');

const HTTP_URL = process.env.HTTP_URL || 'https://mainnet.helius-rpc.com/?api-key=bd671ad8-382f-41fd-9d68-28ee7e46872b';
const WS_URL = process.env.WS_URL || 'wss://mainnet.helius-rpc.com/?api-key=bd671ad8-382f-41fd-9d68-28ee7e46872b';
const TARGET_TOKEN_MINT = 'EAEdoRkGNyYqFsY5ZpiCmE9uauMVxtH1FKiNrQL5pump';
const TRACKED_OWNER = process.env.TRACKED_OWNER || null;
const COMMITMENT = process.env.COMMITMENT || 'processed';

const connection = new Connection(HTTP_URL, {
    wsEndpoint: WS_URL,
    commitment: COMMITMENT
});

const mintPublicKey = new PublicKey(TARGET_TOKEN_MINT);
const accountBalances = new Map();

let targetProgramId = null;
let mintDecimals = 0;

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

async function validateMintAndLoadMeta() {
    const accountInfo = await connection.getAccountInfo(mintPublicKey, COMMITMENT);
    if (!accountInfo) {
        throw new Error(`Mint account ${TARGET_TOKEN_MINT} does not exist.`);
    }

    targetProgramId = accountInfo.owner;

    try {
        const mint = await getMint(connection, mintPublicKey, COMMITMENT, targetProgramId);
        mintDecimals = mint.decimals;
    } catch (error) {
        throw new Error(`Failed to decode mint ${TARGET_TOKEN_MINT}: ${error.message}`);
    }
}

function logDelta({ owner, tokenAccount, deltaRaw, slot }) {
    if (deltaRaw === 0n) return;

    if (TRACKED_OWNER && owner !== TRACKED_OWNER) {
        return;
    }

    const timestamp = new Date().toISOString();
    const amount = formatAmount(deltaRaw, mintDecimals);
    const direction = deltaRaw > 0n ? 'BUY DETECTED' : 'SELL DETECTED';

    console.log(
        `[${timestamp}] ${direction} | Amount: ${amount} | Owner: ${owner} | TokenAccount: ${tokenAccount} | Slot: ${slot}`
    );
}

function decodeTokenAccount(pubkey, accountInfo, programId) {
    try {
        const decoded = unpackAccount(pubkey, accountInfo, programId);
        if (decoded.mint.toBase58() !== TARGET_TOKEN_MINT) return null;

        return {
            owner: decoded.owner.toBase58(),
            amountRaw: decoded.amount
        };
    } catch {
        return null;
    }
}

async function preloadBalances() {
    if (!targetProgramId) return 0;

    const accounts = await connection.getProgramAccounts(targetProgramId, {
        commitment: COMMITMENT,
        filters: [{ memcmp: { offset: 0, bytes: TARGET_TOKEN_MINT } }]
    });

    let loaded = 0;
    for (const account of accounts) {
        const decoded = decodeTokenAccount(account.pubkey, account.account, targetProgramId);
        if (!decoded) continue;
        accountBalances.set(account.pubkey.toBase58(), decoded.amountRaw);
        loaded += 1;
    }

    return loaded;
}

function subscribe(programId) {
    return connection.onProgramAccountChange(
        programId,
        (update, context) => {
            const tokenAccount = update.accountId.toBase58();
            const decoded = decodeTokenAccount(update.accountId, update.accountInfo, programId);
            if (!decoded) return;

            const previous = accountBalances.get(tokenAccount);
            accountBalances.set(tokenAccount, decoded.amountRaw);

            if (previous === undefined) return;

            const deltaRaw = decoded.amountRaw - previous;
            logDelta({
                owner: decoded.owner,
                tokenAccount,
                deltaRaw,
                slot: context.slot
            });
        },
        {
            commitment: COMMITMENT,
            filters: [{ memcmp: { offset: 0, bytes: TARGET_TOKEN_MINT } }]
        }
    );
}

async function start() {
    console.log(`Starting low-latency mint monitor for: ${TARGET_TOKEN_MINT}`);
    console.log(`Commitment: ${COMMITMENT}`);

    if (TRACKED_OWNER) {
        console.log(`Tracking owner only: ${TRACKED_OWNER}`);
    } else {
        console.log('TRACKED_OWNER not set. Logging deltas for all token accounts of this mint.');
    }

    await validateMintAndLoadMeta();
    console.log(`Mint decimals: ${mintDecimals}`);
    console.log(`Mint program: ${targetProgramId.toBase58()}`);

    const preloaded = await preloadBalances();
    console.log(`Preloaded token accounts for baseline: ${preloaded}`);

    const subId = subscribe(targetProgramId);
    console.log(`Subscription id: ${subId}`);
}

start().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
});
