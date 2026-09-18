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
