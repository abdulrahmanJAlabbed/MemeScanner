const { exec } = require('child_process');

// 10 / 3 = 3.33 requests per second max according to GMGN rate limits.
// We'll wait 500ms after each request completes, which safely maximizes the rate (~2 req/s).
const POLL_INTERVAL_MS = 500; 

const seenTokens = new Set();
let isPolling = false;

function formatToken(token) {
    // Simply return the pretty-printed JSON exactly as the API provides
    return JSON.stringify(token, null, 2);
}

function poll() {
    if (isPolling) return;
    isPolling = true;

    exec('gmgn-cli market trenches --chain sol --type new_creation --limit 80 --raw', { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        if (error) {
            // Ignore small execution hitches
        } else {
            try {
                const data = JSON.parse(stdout);
                
                // Handle API error/ban body format
                if (data.code === 429) {
                    console.log(`\n⏳ Rate Limit Hit! Backing off for 6 seconds... (${data.message || ''})`);
                    setTimeout(() => { isPolling = false; poll(); }, 6000);
                    return;
                }
                // With --raw, the field is at the top level
                const newPairs = data.new_creation || (data.data && data.data.new_creation) || [];
                
                newPairs.forEach(item => {
                    if (!seenTokens.has(item.address)) {
                        seenTokens.add(item.address);
                        console.log(formatToken(item));
                    }
                });

            } catch (e) {
                if (stdout.includes('RATE_LIMIT') || stdout.includes('429')) {
                    console.log('\n⏳ Rate Limit Hit! Backing off for 6 seconds...');
                    setTimeout(() => { isPolling = false; poll(); }, 6000);
                    return;
                }
            }
        }

        isPolling = false;
        setTimeout(poll, POLL_INTERVAL_MS);
    });
}

console.log('🚀 Starting live pair scanner (Polling every 500ms to maximize rate limits)...');
isPolling = true;

// Pre-fill initial cache before printing so we only print genuinely NEW events appearing next:
exec('gmgn-cli market trenches --chain sol --type new_creation --limit 80 --raw', { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
    try {
        const data = JSON.parse(stdout);
        const newPairs = data.new_creation || (data.data && data.data.new_creation) || [];
        newPairs.forEach(t => seenTokens.add(t.address));
        console.log(`✅ Loaded ${seenTokens.size} initial pairs silently. Monitoring for new launches arriving now...`);
    } catch(e) {
        console.log('Could not load initial pairs. Will start monitoring directly...');
    }
    isPolling = false;
    poll();
});
