/**
 * Browser V2 — State Management (Multi-Tab)
 * Stores ARIA snapshot refs per tab and resolves them to Playwright locators.
 */

// Per-tab state: pageId → { refs, url, title }
const tabStates = new Map();
let activeTabIndex = 0;

/**
 * Store refs from a snapshot for a specific page.
 * @param {Object} refs - Map of ref ID → { role, name, nth }
 * @param {string} url - Page URL at time of snapshot
 * @param {number} [tabIndex] - Tab index (defaults to active tab)
 */
function storeRefs(refs, url, tabIndex) {
    const idx = tabIndex !== undefined ? tabIndex : activeTabIndex;
    tabStates.set(idx, { refs, url });
}

/**
 * Get the current ref map for the active tab.
 */
function getCurrentRefs() {
    const state = tabStates.get(activeTabIndex);
    return state ? state.refs : {};
}

/**
 * Get the URL from the last snapshot for the active tab.
 */
function getCurrentUrl() {
    const state = tabStates.get(activeTabIndex);
    return state ? state.url : '';
}

/**
 * Clear refs for the active tab (e.g. on navigation).
 */
function clearRefs() {
    tabStates.delete(activeTabIndex);
}

/**
 * Clear refs for a specific tab and re-index all tabs above it.
 * This must be called when a tab is closed so that indices stay aligned
 * with browser.pages() array positions.
 * @param {number} tabIndex - Index of the closed tab
 */
function clearTabRefs(tabIndex) {
    tabStates.delete(tabIndex);

    // Re-index: shift all entries above tabIndex down by 1
    const toReIndex = [];
    for (const [idx, state] of tabStates.entries()) {
        if (idx > tabIndex) {
            toReIndex.push({ oldIdx: idx, state });
        }
    }
    for (const { oldIdx, state } of toReIndex) {
        tabStates.delete(oldIdx);
        tabStates.set(oldIdx - 1, state);
    }
}

/**
 * Set the active tab index.
 * @param {number} index
 */
function setActiveTab(index) {
    activeTabIndex = index;
}

/**
 * Get the active tab index.
 * @returns {number}
 */
function getActiveTab() {
    return activeTabIndex;
}

/**
 * Resolve a ref ID to a Playwright Locator.
 * Uses getByRole() for semantic, CSS-independent element targeting.
 *
 * @param {import('playwright').Page} page
 * @param {string} ref - e.g. "e1", "e2"
 * @param {string} [frameSelector] - e.g. "iframe[title='Stripe']"
 * @returns {import('playwright').Locator}
 */
function refLocator(page, ref, frameSelector = '') {
    const state = tabStates.get(activeTabIndex);
    const currentRefs = state ? state.refs : {};
    const info = currentRefs[ref];
    if (!info) {
        const available = Object.keys(currentRefs).slice(0, 10).join(', ');
        throw new Error(
            `Unknown ref "${ref}". Call browser_snapshot first to get current refs. ` +
            `Available: [${available}${Object.keys(currentRefs).length > 10 ? ', ...' : ''}]`
        );
    }

    const root = frameSelector ? page.frameLocator(frameSelector) : page;

    let locator;
    if (info.name) {
        locator = root.getByRole(info.role, { name: info.name, exact: true });
    } else {
        locator = root.getByRole(info.role);
    }

    return info.nth !== undefined ? locator.nth(info.nth) : locator;
}

module.exports = { storeRefs, getCurrentRefs, getCurrentUrl, clearRefs, clearTabRefs, setActiveTab, getActiveTab, refLocator };
