// Which sidebar entry is the current page.
//
// An entry may point at a tab of a page ("/brain?tab=approvals"). Such an
// entry lights up only on that tab, and the plain entry for the same page
// ("/brain") lights up on every other tab, so exactly one is ever lit.

/**
 * @param {string} href - the entry's link, with or without a query
 * @param {string} pathname - the current path
 * @param {string|null} activeTab - the current `tab` query value
 * @param {Array<{href: string}>} items - every entry, to spot tabs that have their own
 */
export function isNavActive(href, pathname, activeTab, items = []) {
    const [path, query] = String(href || '').split('?');
    if (pathname !== path) return false;
    const tab = query ? new URLSearchParams(query).get('tab') : null;
    if (tab) return activeTab === tab;
    if (!activeTab) return true;
    // A tab with an entry of its own owns the highlight.
    return !items.some(i => String(i.href || '') === `${path}?tab=${activeTab}`);
}

/**
 * Where an entry's click goes. An entry with a badge may name a second
 * address for the moments the badge shows: Brain opens on its approvals tab
 * while an approval waits, and on its first tab otherwise.
 * @param {{ href: string, badgeHref?: string }} item
 * @param {number} badgeCount
 */
export function navHref(item, badgeCount = 0) {
    return badgeCount > 0 && item?.badgeHref ? item.badgeHref : item?.href;
}
