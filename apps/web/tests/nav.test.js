// Which sidebar entry lights up, now that a tab of a page can have its own.
const { isNavActive } = require('../src/lib/nav.js');

const ITEMS = [
    { href: '/chat' },
    { href: '/brain?tab=approvals' },
    { href: '/brain' },
];

describe('which sidebar entry is lit', () => {
    test('a plain entry lights up on its own page', () => {
        expect(isNavActive('/chat', '/chat', null, ITEMS)).toBe(true);
        expect(isNavActive('/chat', '/brain', null, ITEMS)).toBe(false);
    });

    test('an entry that points at a tab lights up only on that tab', () => {
        expect(isNavActive('/brain?tab=approvals', '/brain', 'approvals', ITEMS)).toBe(true);
        expect(isNavActive('/brain?tab=approvals', '/brain', 'memory', ITEMS)).toBe(false);
        expect(isNavActive('/brain?tab=approvals', '/brain', null, ITEMS)).toBe(false);
    });

    test('the page entry keeps every other tab, and yields the one that has its own entry', () => {
        expect(isNavActive('/brain', '/brain', null, ITEMS)).toBe(true);
        expect(isNavActive('/brain', '/brain', 'memory', ITEMS)).toBe(true);
        expect(isNavActive('/brain', '/brain', 'approvals', ITEMS)).toBe(false);
    });

    test('exactly one entry is lit, whatever the tab', () => {
        for (const tab of [null, 'memory', 'approvals', 'guardian', 'nonsense']) {
            const lit = ITEMS.filter(i => isNavActive(i.href, '/brain', tab, ITEMS));
            expect(lit).toHaveLength(1);
        }
    });
});

describe('the sidebar as it is: approvals and the guardian have no entry of their own', () => {
    const { navHref } = require('../src/lib/nav.js');
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../src/components/Sidebar.js'), 'utf8');

    test('no Approvals or Guardian entry is left in the sidebar', () => {
        // Either quote style, so a formatter cannot make this pass on nothing.
        const names = [...source.matchAll(/\bname:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
        expect(names.length).toBeGreaterThan(5);
        expect(names).toContain('Brain');
        expect(names).not.toContain('Approvals');
        expect(names).not.toContain('Guardian');
        // No entry points at a tab, so nothing can steal Brain's highlight.
        const hrefs = [...source.matchAll(/\bhref:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
        expect(hrefs).toContain('/brain');
        expect(hrefs.filter(h => h.includes('?'))).toEqual([]);
    });

    test('Brain is lit on every one of its tabs', () => {
        const items = [{ href: '/' }, { href: '/brain' }, { href: '/tasks' }];
        for (const tab of [null, 'approvals', 'guardian', 'memory']) {
            expect(isNavActive('/brain', '/brain', tab, items)).toBe(true);
        }
    });

    test('Brain opens on the approvals tab only while an approval waits', () => {
        const brain = { href: '/brain', badgeHref: '/brain?tab=approvals' };
        expect(navHref(brain, 0)).toBe('/brain');
        expect(navHref(brain, 2)).toBe('/brain?tab=approvals');
        // An entry with no second address never changes.
        expect(navHref({ href: '/tasks' }, 5)).toBe('/tasks');
    });
});
