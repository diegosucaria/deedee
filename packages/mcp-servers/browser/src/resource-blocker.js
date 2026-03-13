/**
 * Browser V2 — Resource Blocker
 * Blocks unnecessary resources (images, fonts, media, ads) to speed up page loads.
 * Default: block images, fonts, media. Agent can toggle via browser_set_resource_blocking.
 * Supports browser restart: tracks which context has been instrumented via WeakSet.
 */

// Default blocked resource types
let blockedTypes = new Set(['image', 'font', 'media']);

// Known ad/tracker domains
const AD_DOMAINS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'facebook.net', 'fbcdn.net', 'analytics.google.com',
    'adnxs.com', 'adsrvr.org', 'criteo.com', 'outbrain.com',
    'taboola.com', 'amazon-adsystem.com', 'moatads.com',
];

// Track which contexts have been instrumented
const instrumentedContexts = new WeakSet();

/**
 * Install resource blocker on the browser context.
 * Uses context.route() so it applies to all pages.
 * Safe to call after browser restart — re-installs on new context.
 *
 * @param {import('playwright').BrowserContext} context
 */
async function installResourceBlocker(context) {
    if (instrumentedContexts.has(context)) return;
    instrumentedContexts.add(context);

    await context.route('**/*', (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        const url = request.url();

        // Block by resource type
        if (blockedTypes.has(resourceType)) {
            return route.abort();
        }

        // Block known ad/tracker domains
        if (blockedTypes.size > 0) {
            try {
                const hostname = new URL(url).hostname;
                if (AD_DOMAINS.some(ad => hostname.includes(ad))) {
                    return route.abort();
                }
            } catch { /* invalid URL, let through */ }
        }

        return route.continue();
    });
}

/**
 * Update the set of blocked resource types.
 * @param {string[]} types - Resource types to block, or empty/["none"] to disable
 */
function setBlockedTypes(types) {
    if (!types || types.length === 0 || (types.length === 1 && types[0] === 'none')) {
        blockedTypes = new Set();
    } else {
        blockedTypes = new Set(types);
    }
}

/**
 * Get currently blocked resource types.
 * @returns {string[]}
 */
function getBlockedTypes() {
    return [...blockedTypes];
}

module.exports = { installResourceBlocker, setBlockedTypes, getBlockedTypes };
