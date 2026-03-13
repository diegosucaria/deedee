/**
 * Browser V2 — Wait Primitives
 * Supports waiting for text, text disappearance, URL, load state, time,
 * and network responses.
 */

const MAX_TIMEOUT = 60000;
const MAX_TIME_MS = 10000;

// Lazy-loaded network module reference
let networkModule = null;
function getNetworkModule() {
    if (!networkModule) {
        try {
            networkModule = require('./network');
        } catch { /* not available */ }
    }
    return networkModule;
}

/**
 * Wait for a condition on the page.
 *
 * @param {import('playwright').Page} page
 * @param {Object} args - { text?, textGone?, url?, loadState?, timeMs?, networkUrl?, timeout? }
 */
async function handleWait(page, args) {
    const timeout = Math.min(args.timeout || 30000, MAX_TIMEOUT);
    const results = [];

    if (args.timeMs) {
        const ms = Math.min(args.timeMs, MAX_TIME_MS);
        await page.waitForTimeout(ms);
        results.push(`Waited ${ms}ms`);
    }

    if (args.text) {
        await page.getByText(args.text).first().waitFor({ state: 'visible', timeout });
        results.push(`Text "${args.text}" appeared`);
    }

    if (args.textGone) {
        await page.getByText(args.textGone).first().waitFor({ state: 'hidden', timeout });
        results.push(`Text "${args.textGone}" disappeared`);
    }

    if (args.url) {
        await page.waitForURL(args.url, { timeout });
        results.push(`URL matched "${args.url}"`);
    }

    if (args.loadState) {
        try {
            await page.waitForLoadState(args.loadState, { timeout });
            results.push(`Load state "${args.loadState}" reached`);
        } catch (err) {
            if (err.name === 'TimeoutError') {
                // loadState (especially networkidle) may never resolve on heavy sites.
                // Don't fail — report it and let the agent continue with the current page state.
                results.push(`⚠️ Load state "${args.loadState}" timed out — page may still be usable`);
            } else {
                throw err;
            }
        }
    }

    if (args.networkUrl) {
        const net = getNetworkModule();
        if (net) {
            const entry = await net.waitForNetworkResponse(args.networkUrl, timeout);
            results.push(`Network response for "${args.networkUrl}" received (status: ${entry.status})`);
        } else {
            results.push('Network module not available');
        }
    }

    return {
        success: true,
        url: page.url(),
        message: results.length > 0 ? results.join(', ') : 'No wait condition specified',
    };
}

module.exports = { handleWait };
