// The WhatsApp diagnostics block. The fault it guards against: a failed probe
// reading as a pass, and a store error printing as NaN MB.
const { diagnosticLines, formatBytes } = require('../src/lib/whatsapp-diagnostics.js');

describe('formatBytes', () => {
    test('sizes read in the unit that fits', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(900)).toBe('900 B');
        expect(formatBytes(2048)).toBe('2.0 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    });

    test('a missing size is a dash, never NaN', () => {
        for (const none of [undefined, null, 'big', -1]) expect(formatBytes(none)).toBe('-');
    });
});

describe('diagnosticLines', () => {
    const healthy = {
        session: 'user',
        status: 'connected',
        timestamp: '2026-09-22T12:00:00.000Z',
        probes: { presence: { success: true, latency: 42 }, blocklist: { success: true, count: 3, latency: 55 } },
        store: { contacts: 120, messages: 4500, sizeBytes: 2 * 1024 * 1024 }
    };

    test('a healthy session reads as all good', () => {
        const lines = diagnosticLines(healthy);
        expect(lines.every(l => l.ok)).toBe(true);
        expect(lines.map(l => l.label)).toEqual(['State', 'Presence probe', 'Blocklist probe', 'Store']);
        expect(lines[1].detail).toBe('42 ms');
        expect(lines[2].detail).toBe('3 entries, 55 ms');
        expect(lines[3].detail).toBe('120 contacts, 4500 messages, 2.0 MB');
    });

    test('a failed probe is marked failed and says why', () => {
        const lines = diagnosticLines({ ...healthy, probes: { presence: { success: false, error: 'Timed Out' } } });
        const presence = lines.find(l => l.label === 'Presence probe');
        expect(presence.ok).toBe(false);
        expect(presence.detail).toBe('Timed Out');
    });

    test('a socket that is down is reported, not hidden', () => {
        const lines = diagnosticLines({ session: 'user', status: 'needs_repair', error: 'Socket not connected', probes: {}, store: {} });
        expect(lines[0]).toEqual({ label: 'State', ok: false, detail: 'needs_repair' });
        expect(lines[1]).toEqual({ label: 'Socket', ok: false, detail: 'Socket not connected' });
    });

    test('a store error replaces the counts instead of printing nothing', () => {
        const lines = diagnosticLines({ ...healthy, store: { error: 'No Store' } });
        const store = lines.find(l => l.label === 'Store');
        expect(store).toEqual({ label: 'Store', ok: false, detail: 'No Store' });
    });

    test('no report, no lines', () => {
        for (const none of [null, undefined, 'oops', 42]) expect(diagnosticLines(none)).toEqual([]);
    });

    test('a probe name we have no label for still shows', () => {
        const lines = diagnosticLines({ status: 'connected', probes: { newProbe: { success: true } }, store: {} });
        expect(lines[1]).toEqual({ label: 'newProbe', ok: true, detail: 'ok' });
    });
});
