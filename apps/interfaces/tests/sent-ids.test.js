const { SentIds, DEFAULT_TTL_MS } = require('../src/sent-ids');

describe('SentIds', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-16T10:00:00.000Z'));
    });
    afterEach(() => jest.useRealTimers());

    test('remembers an id for 24 hours and ignores falsy ids', () => {
        const ids = new SentIds();
        expect(DEFAULT_TTL_MS).toBe(24 * 60 * 60e3);
        expect(ids.has('a')).toBe(false);
        ids.add('a');
        expect(ids.has('a')).toBe(true);
        ids.add(null); ids.add(undefined); ids.add('');
        expect(ids.has(null)).toBe(false);
        expect(ids.size).toBe(1);

        jest.advanceTimersByTime(DEFAULT_TTL_MS - 1000);
        expect(ids.has('a')).toBe(true);
        jest.advanceTimersByTime(2000);
        expect(ids.has('a')).toBe(false);
        expect(ids.size).toBe(0);
    });

    test('delete forgets an id; the set is capped at max entries, oldest first', () => {
        const ids = new SentIds({ max: 3 });
        ids.add('a'); ids.delete('a');
        expect(ids.has('a')).toBe(false);
        ids.add('1'); ids.add('2'); ids.add('3'); ids.add('4');
        expect(ids.size).toBe(3);
        expect(ids.has('1')).toBe(false);
        expect(ids.has('4')).toBe(true);
    });
});
