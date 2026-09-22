// The Models tab prints prices and smoke ages. These guard the arithmetic
// the page cannot: a free row read as "-", a tiered price shown as one number,
// a 0.075 rate rounded away to $0.08.
const { formatPrice, shortCount, priceLines, timeAgo, smokeStyle } = require('../src/lib/models.js');

describe('formatPrice', () => {
    test('a price keeps enough digits to stay true', () => {
        expect(formatPrice(0.075)).toBe('$0.075');
        expect(formatPrice(0.75)).toBe('$0.75');
        expect(formatPrice(3.75)).toBe('$3.75');
        expect(formatPrice(120)).toBe('$120.00');
    });

    test('free is free, and no price is a dash', () => {
        expect(formatPrice(0)).toBe('free');
        expect(formatPrice(null)).toBe('-');
        expect(formatPrice(undefined)).toBe('-');
        expect(formatPrice('nonsense')).toBe('-');
    });
});

describe('shortCount', () => {
    test('a threshold reads as a short count', () => {
        expect(shortCount(200000)).toBe('200k');
        expect(shortCount(1000000)).toBe('1M');
        expect(shortCount(512)).toBe('512');
        expect(shortCount(undefined)).toBe('');
    });
});

describe('priceLines', () => {
    const flat = { threshold: null, tier1: { input: 0.75, output: 3.75, cachedInput: 0.075, outputText: null }, tier2: { input: 0.75, output: 3.75, cachedInput: 0.075, outputText: null } };
    const tiered = { threshold: 200000, tier1: { input: 2, output: 12, cachedInput: 0.2, outputText: null }, tier2: { input: 4, output: 18, cachedInput: 0.4, outputText: null } };

    test('a flat price is one line with no label', () => {
        expect(priceLines(flat)).toEqual([{ label: null, input: 0.75, output: 3.75, cachedInput: 0.075, outputText: null }]);
    });

    test('a tiered price is two lines, split at the threshold', () => {
        const lines = priceLines(tiered);
        expect(lines.map(l => l.label)).toEqual(['up to 200k', 'over 200k']);
        expect(lines[1].input).toBe(4);
    });

    test('an image row keeps its text output rate', () => {
        const image = { threshold: null, tier1: { input: 2, output: 120, cachedInput: 0.2, outputText: 12 }, tier2: { input: 2, output: 120, cachedInput: 0.2, outputText: 12 } };
        expect(priceLines(image)[0].outputText).toBe(12);
    });

    test('no price, no lines', () => {
        for (const none of [null, undefined, {}, { tier1: null }]) expect(priceLines(none)).toEqual([]);
    });
});

describe('timeAgo', () => {
    const now = Date.parse('2026-09-22T12:00:00.000Z');

    test('a run reads as how long ago it was', () => {
        expect(timeAgo('2026-09-22T11:59:30.000Z', now)).toBe('just now');
        expect(timeAgo('2026-09-22T11:30:00.000Z', now)).toBe('30m ago');
        expect(timeAgo('2026-09-22T08:00:00.000Z', now)).toBe('4h ago');
        expect(timeAgo('2026-09-19T12:00:00.000Z', now)).toBe('3d ago');
    });

    test('a run that never happened, or a broken date, says never', () => {
        expect(timeAgo(null, now)).toBe('never');
        expect(timeAgo('', now)).toBe('never');
        expect(timeAgo('yesterday-ish', now)).toBe('never');
    });

    test('a clock that ran backwards does not print a negative age', () => {
        expect(timeAgo('2026-09-22T12:05:00.000Z', now)).toBe('just now');
    });
});

describe('smokeStyle', () => {
    test('each status has its own colour and an unknown one stays grey', () => {
        expect(smokeStyle('ok')).toContain('emerald');
        expect(smokeStyle('fail')).toContain('red');
        expect(smokeStyle('skip')).toContain('amber');
        expect(smokeStyle('something else')).toContain('zinc');
        expect(smokeStyle(undefined)).toContain('zinc');
    });
});
