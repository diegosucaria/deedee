// The cache behind the expanded sub-agent row: when it reads again.
const { needsFullResult, fullResultEntry } = require('../src/lib/full-result-cache.js');

describe('needsFullResult', () => {
    test('no row open, no read', () => {
        expect(needsFullResult({}, null, undefined)).toBe(false);
    });

    test('a row with no entry reads', () => {
        expect(needsFullResult({}, 'a1', 'completed')).toBe(true);
    });

    test('an entry read at the same status stays', () => {
        const cache = { a1: fullResultEntry('completed', { result_full: 'whole text' }) };
        expect(needsFullResult(cache, 'a1', 'completed')).toBe(false);
    });

    test('a row opened while running reads again when it finishes', () => {
        const cache = { a1: fullResultEntry('running', { result_full: null }) };
        expect(needsFullResult(cache, 'a1', 'running')).toBe(false);
        expect(needsFullResult(cache, 'a1', 'completed')).toBe(true);
    });

    test('a failed read does not retry until the status changes', () => {
        const cache = { a1: fullResultEntry('completed', null) };
        expect(needsFullResult(cache, 'a1', 'completed')).toBe(false);
        expect(needsFullResult(cache, 'a1', 'timeout')).toBe(true);
    });
});

describe('fullResultEntry', () => {
    test('a read that failed is marked, not cached as empty', () => {
        expect(fullResultEntry('completed', null)).toEqual({ status: 'completed', text: null, failed: true });
    });

    test('a short result has no full text and that is not a failure', () => {
        expect(fullResultEntry('completed', { result: 'short' })).toEqual({ status: 'completed', text: null, failed: false });
    });

    test('a shortened result keeps the whole text', () => {
        expect(fullResultEntry('completed', { result: 'short', result_full: 'the whole text' }))
            .toEqual({ status: 'completed', text: 'the whole text', failed: false });
    });
});
