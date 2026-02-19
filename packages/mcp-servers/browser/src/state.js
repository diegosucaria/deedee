/**
 * Browser V2 — State Management
 * Stores ARIA snapshot refs and resolves them to Playwright locators.
 * DeeDee uses a single page at a time — no multi-tab state needed.
 */

// Module-level state
let currentRefs = {};  // ref → { role, name, nth }
let currentUrl = '';

/**
 * Store refs from a snapshot.
 * @param {Object} refs - Map of ref ID → { role, name, nth }
 * @param {string} url - Page URL at time of snapshot
 */
function storeRefs(refs, url) {
    currentRefs = refs;
    currentUrl = url;
}

/**
 * Get the current ref map.
 */
function getCurrentRefs() {
    return currentRefs;
}

/**
 * Get the URL from the last snapshot.
 */
function getCurrentUrl() {
    return currentUrl;
}

/**
 * Clear all refs (e.g. on navigation).
 */
function clearRefs() {
    currentRefs = {};
    currentUrl = '';
}

/**
 * Resolve a ref ID to a Playwright Locator.
 * Uses getByRole() for semantic, CSS-independent element targeting.
 *
 * @param {import('playwright').Page} page
 * @param {string} ref - e.g. "e1", "e2"
 * @returns {import('playwright').Locator}
 */
function refLocator(page, ref) {
    const info = currentRefs[ref];
    if (!info) {
        const available = Object.keys(currentRefs).slice(0, 10).join(', ');
        throw new Error(
            `Unknown ref "${ref}". Call browser_snapshot first to get current refs. ` +
            `Available: [${available}${Object.keys(currentRefs).length > 10 ? ', ...' : ''}]`
        );
    }

    let locator;
    if (info.name) {
        locator = page.getByRole(info.role, { name: info.name, exact: true });
    } else {
        locator = page.getByRole(info.role);
    }

    return info.nth !== undefined ? locator.nth(info.nth) : locator;
}

module.exports = { storeRefs, getCurrentRefs, getCurrentUrl, clearRefs, refLocator };
