/**
 * pending_confirmations: rows survive across AgentDB instances (a restart),
 * only one decision wins, and the sweeper expires overdue rows.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');

const base = (over = {}) => ({
    id: 'abcd1234',
    originChatId: 'scheduled_job_1700000000000',
    originSource: 'scheduler',
    originMeta: { jobName: 'job' },
    replyChatId: '10000000000@s.whatsapp.net',
    replyChannel: 'whatsapp',
    mode: 'deferred',
    toolName: 'sendEmail',
    args: { to: 'alice@example.com', subject: 'Hi' },
    summary: 'sendEmail to alice@example.com',
    reason: 'Sending email needs approval.',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over
});

describe('pending_confirmations helpers', () => {
    let dir, db;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-approvals-db-'));
        db = new AgentDB(dir);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('create stores args, meta and mode as JSON and reads them back', () => {
        const row = db.createPendingConfirmation(base());
        expect(row.id).toBe('abcd1234');
        expect(row.status).toBe('pending');
        expect(row.args).toEqual({ to: 'alice@example.com', subject: 'Hi' });
        expect(row.origin_meta).toEqual({ jobName: 'job' });
        expect(row.mode).toBe('deferred');
        expect(row.reply_channel).toBe('whatsapp');
        expect(row.created_at).toBeTruthy();
    });

    test('rows survive a reopen of the database (restart)', () => {
        db.createPendingConfirmation(base());
        db.close();
        db = new AgentDB(dir);
        const pending = db.listPendingConfirmations();
        expect(pending).toHaveLength(1);
        expect(pending[0].tool_name).toBe('sendEmail');
    });

    test('listPendingConfirmations filters by reply chat and skips overdue rows', () => {
        db.createPendingConfirmation(base({ id: 'a1' }));
        db.createPendingConfirmation(base({ id: 'a2', replyChatId: 'web-chat' }));
        db.createPendingConfirmation(base({ id: 'a3', expiresAt: new Date(Date.now() - 1000).toISOString() }));
        expect(db.listPendingConfirmations().map(r => r.id)).toEqual(['a1', 'a2']);
        expect(db.listPendingConfirmations({ replyChatId: 'web-chat' }).map(r => r.id)).toEqual(['a2']);
    });

    test('only the first decision wins', () => {
        db.createPendingConfirmation(base());
        const first = db.decidePendingConfirmation('abcd1234', 'approved', { via: 'chat' });
        expect(first.status).toBe('approved');
        expect(first.decided_via).toBe('chat');
        expect(first.decided_at).toBeTruthy();
        expect(db.decidePendingConfirmation('abcd1234', 'denied', { via: 'web' })).toBeNull();
        expect(db.getPendingConfirmation('abcd1234').status).toBe('approved');
    });

    test('an overdue row cannot be approved or denied, only expired', () => {
        db.createPendingConfirmation(base({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
        expect(db.decidePendingConfirmation('abcd1234', 'approved', { via: 'web' })).toBeNull();
        expect(db.decidePendingConfirmation('abcd1234', 'denied', { via: 'chat' })).toBeNull();
        expect(db.getPendingConfirmation('abcd1234').status).toBe('pending');
        expect(db.decidePendingConfirmation('abcd1234', 'expired', { via: 'sweeper' }).status).toBe('expired');
    });

    test('rejects unknown statuses', () => {
        db.createPendingConfirmation(base());
        expect(() => db.decidePendingConfirmation('abcd1234', 'maybe')).toThrow(/bad confirmation status/);
    });

    test('the sweeper expires overdue rows and returns them once', () => {
        db.createPendingConfirmation(base({ id: 'old', expiresAt: new Date(Date.now() - 1000).toISOString() }));
        db.createPendingConfirmation(base({ id: 'fresh' }));
        const expired = db.expirePendingConfirmations();
        expect(expired.map(r => r.id)).toEqual(['old']);
        expect(db.getPendingConfirmation('old').status).toBe('expired');
        expect(db.getPendingConfirmation('old').decided_via).toBe('sweeper');
        expect(db.getPendingConfirmation('fresh').status).toBe('pending');
        expect(db.expirePendingConfirmations()).toEqual([]);
    });

    test('result, counts, recent list and cleanup', () => {
        db.createPendingConfirmation(base({ id: 'r1' }));
        db.createPendingConfirmation(base({ id: 'r2', createdAt: '2020-01-01T00:00:00.000Z' }));
        db.decidePendingConfirmation('r1', 'approved', { via: 'web' });
        db.setConfirmationResult('r1', { success: true });
        expect(db.getPendingConfirmation('r1').result).toEqual({ success: true });
        db.decidePendingConfirmation('r2', 'denied', { via: 'chat' });
        expect(db.countConfirmationsByStatus()).toEqual({ pending: 0, approved: 1, denied: 1, expired: 0 });
        expect(db.listRecentConfirmations({ limit: 1 })).toHaveLength(1);
        expect(db.cleanupConfirmations(30)).toBe(1);
        expect(db.getPendingConfirmation('r2')).toBeNull();
        expect(db.getPendingConfirmation('r1')).not.toBeNull();
    });
});
