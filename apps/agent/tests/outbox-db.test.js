/**
 * notification_outbox helpers: enqueue, claim with lease, sent/failed with
 * backoff, dead letter, fallback note, dedupe lookup, listing and counts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');

const PAYLOAD = { content: 'Meeting at 10', type: 'text' };

describe('AgentDB notification_outbox', () => {
    let dir, db;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-outbox-db-'));
        db = new AgentDB(dir);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('enqueueOutbox stores the row as pending and due now', () => {
        const row = db.enqueueOutbox({
            kind: 'reminder', channel: 'whatsapp', target: '5490000000000@s.whatsapp.net',
            payload: PAYLOAD, origin: 'reminder_1', contentHash: 'abc'
        });
        expect(row.id).toBeTruthy();
        expect(row.status).toBe('pending');
        expect(row.attempts).toBe(0);
        expect(row.payload).toEqual(PAYLOAD);
        expect(row.origin).toBe('reminder_1');
        expect(new Date(row.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now());
        expect(db.countOutboxByStatus()).toEqual({ pending: 1, sent: 0, failed: 0, dead: 0 });
    });

    test('enqueueOutbox accepts a preset failed state for a reply that already failed once', () => {
        const next = new Date(Date.now() + 60_000).toISOString();
        const row = db.enqueueOutbox({
            kind: 'reply', channel: 'telegram', target: '42', payload: PAYLOAD,
            status: 'failed', attempts: 1, lastError: 'refused', nextAttemptAt: next
        });
        expect(row.status).toBe('failed');
        expect(row.attempts).toBe(1);
        expect(row.last_error).toBe('refused');
        expect(row.next_attempt_at).toBe(next);
    });

    test('claimDueOutbox returns due rows once and leases them', () => {
        const due = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        db.enqueueOutbox({
            kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD,
            nextAttemptAt: new Date(Date.now() + 3600_000).toISOString()
        });
        const sent = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        db.markOutboxSent(sent.id);

        const claimed = db.claimDueOutbox(10);
        expect(claimed.map(r => r.id)).toEqual([due.id]);
        // The lease pushes the row out of the due window.
        expect(db.claimDueOutbox(10)).toEqual([]);
        expect(new Date(db.getOutboxRow(due.id).next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    });

    test('markOutboxSent records the channel that delivered', () => {
        const row = db.enqueueOutbox({ kind: 'system_alert', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        const sent = db.markOutboxSent(row.id, { via: 'telegram' });
        expect(sent.status).toBe('sent');
        expect(sent.delivered_via).toBe('telegram');
        expect(sent.attempts).toBe(1);
        expect(sent.sent_at).toBeTruthy();

        const primary = db.enqueueOutbox({ kind: 'system_alert', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        expect(db.markOutboxSent(primary.id).delivered_via).toBe('whatsapp');
    });

    test('markOutboxFailed backs off 1m, 5m, 15m, 1h, 1h and dies on the sixth attempt', () => {
        const row = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        const now = new Date('2026-09-16T10:00:00.000Z');
        const expected = [60e3, 300e3, 900e3, 3600e3, 3600e3];
        let current = row;
        expected.forEach((delay, i) => {
            current = db.markOutboxFailed(current.id, `err ${i}`, { now });
            expect(current.status).toBe('failed');
            expect(current.attempts).toBe(i + 1);
            expect(current.last_error).toBe(`err ${i}`);
            expect(new Date(current.next_attempt_at).getTime() - now.getTime()).toBe(delay);
        });
        const dead = db.markOutboxFailed(current.id, 'final', { now });
        expect(dead.status).toBe('dead');
        expect(dead.attempts).toBe(6);
        expect(dead.next_attempt_at).toBeNull();
        expect(dead.last_error).toBe('final');
        expect(db.claimDueOutbox(10)).toEqual([]);
    });

    test('markOutboxFailed honours custom backoff and attempt limits', () => {
        const row = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        const now = new Date('2026-09-16T10:00:00.000Z');
        const first = db.markOutboxFailed(row.id, 'e', { now, backoffMs: [1000], maxAttempts: 2 });
        expect(new Date(first.next_attempt_at).getTime() - now.getTime()).toBe(1000);
        expect(db.markOutboxFailed(row.id, 'e', { now, backoffMs: [1000], maxAttempts: 2 }).status).toBe('dead');
    });

    test('deadLetterOutbox and resetOutboxRow move a row out of and back into the queue', () => {
        const row = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        const dead = db.deadLetterOutbox(row.id, 'expired');
        expect(dead.status).toBe('dead');
        expect(dead.last_error).toBe('expired');

        const reset = db.resetOutboxRow(row.id);
        expect(reset.status).toBe('pending');
        expect(db.claimDueOutbox(10).map(r => r.id)).toEqual([row.id]);

        db.markOutboxSent(row.id);
        expect(db.resetOutboxRow(row.id)).toBeNull();
        expect(db.getOutboxRow(row.id).status).toBe('sent');
    });

    test('noteOutboxFallback stores the fallback attempt', () => {
        const row = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        const noted = db.noteOutboxFallback(row.id, { channel: 'telegram', target: '42', status: 'failed', error: 'tg down' });
        expect(noted.fallback_channel).toBe('telegram');
        expect(noted.fallback_target).toBe('42');
        expect(noted.fallback_status).toBe('failed');
        expect(noted.fallback_at).toBeTruthy();
        expect(noted.last_error).toBe('tg down');

        const ok = db.noteOutboxFallback(row.id, { channel: 'telegram', target: '42', status: 'sent' });
        expect(ok.fallback_status).toBe('sent');
        expect(ok.last_error).toBe('tg down');
    });

    test('findOutboxDuplicate matches kind, target and hash inside the window', () => {
        const row = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD, contentHash: 'h1' });
        const since = new Date(Date.now() - 10 * 60_000);
        expect(db.findOutboxDuplicate('reminder', 't', 'h1', since).id).toBe(row.id);
        expect(db.findOutboxDuplicate('reminder', 't', 'h2', since)).toBeNull();
        expect(db.findOutboxDuplicate('reply', 't', 'h1', since)).toBeNull();
        expect(db.findOutboxDuplicate('reminder', 'other', 'h1', since)).toBeNull();
        expect(db.findOutboxDuplicate('reminder', 't', 'h1', new Date(Date.now() + 1000))).toBeNull();
        expect(db.findOutboxDuplicate('reminder', 't', null, since)).toBeNull();
    });

    test('listRecentOutbox orders newest first and filters by status', () => {
        const a = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD, createdAt: '2026-09-16T10:00:00.000Z' });
        const b = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD, createdAt: '2026-09-16T11:00:00.000Z' });
        db.markOutboxSent(b.id);
        expect(db.listRecentOutbox({ limit: 10 }).map(r => r.id)).toEqual([b.id, a.id]);
        expect(db.listRecentOutbox({ limit: 10, status: 'sent' }).map(r => r.id)).toEqual([b.id]);
        expect(db.listRecentOutbox({ limit: 1 }).length).toBe(1);
        expect(db.countOutboxByStatus()).toEqual({ pending: 1, sent: 1, failed: 0, dead: 0 });
    });

    test('cleanupOutbox removes old sent and dead rows only', () => {
        const old = '2026-01-01T00:00:00.000Z';
        const sent = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD, createdAt: old });
        db.markOutboxSent(sent.id);
        const dead = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD, createdAt: old });
        db.deadLetterOutbox(dead.id, 'x');
        const pending = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD, createdAt: old });
        const fresh = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        db.markOutboxSent(fresh.id);

        expect(db.cleanupOutbox(30)).toBe(2);
        expect(db.listRecentOutbox({ limit: 10 }).map(r => r.id).sort()).toEqual([fresh.id, pending.id].sort());
    });

    test('a corrupt payload column reads back as an empty object', () => {
        const row = db.enqueueOutbox({ kind: 'reminder', channel: 'whatsapp', target: 't', payload: PAYLOAD });
        db.db.prepare('UPDATE notification_outbox SET payload = ? WHERE id = ?').run('{not json', row.id);
        expect(db.getOutboxRow(row.id).payload).toEqual({});
    });
});
