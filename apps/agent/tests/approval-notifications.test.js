/**
 * An approval he has answered should stop asking from the bell. Nothing
 * linked a decided approval to the notification it created, so three cards
 * for one booking sat unread for ever.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');

function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-approval-notif-'));
    return { dir, db: new AgentDB(dir) };
}

const ask = (db, id, overrides = {}) => db.createPendingConfirmation({
    id,
    toolName: 'book_appointment',
    args: { confirm: true },
    summary: 'confirm: true',
    reason: 'booking',
    replyChatId: 'owner@s.whatsapp.net',
    replyChannel: 'whatsapp',
    mode: 'deferred',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    ...overrides
});

const notify = (db, id, approvalId, read = 0) => {
    db.createNotification({
        id,
        type: 'approval',
        severity: 'warning',
        title: 'Approval needed: book_appointment',
        message: 'confirm: true',
        metadata: { approvalId, link: '/settings?tab=approvals' }
    });
    if (read) db.markNotificationRead(id);
};

const unread = (db) => db.getNotifications({ limit: 50 }).map(n => n.id).sort();
const all = (db) => db.getNotifications({ limit: 50, includeRead: true }).map(n => n.id).sort();

describe('the bell after an approval is decided', () => {
    let dir, db, spies;

    beforeEach(() => {
        ({ dir, db } = tempDb());
        spies = ['log', 'warn'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        spies.forEach(s => s.mockRestore());
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a yes clears its own entry and leaves the others alone', () => {
        ask(db, 'a1');
        ask(db, 'a2');
        notify(db, 'n1', 'a1');
        notify(db, 'n2', 'a2');
        expect(unread(db)).toEqual(['n1', 'n2']);

        expect(db.decidePendingConfirmation('a1', 'approved', { via: 'chat' })).toBeTruthy();
        expect(unread(db)).toEqual(['n2']);
        // The row stays, so the history still shows what was asked.
        expect(all(db)).toEqual(['n1', 'n2']);
    });

    test('a no clears it too, and a second answer changes nothing', () => {
        ask(db, 'a1');
        notify(db, 'n1', 'a1');
        db.decidePendingConfirmation('a1', 'denied', { via: 'web' });
        expect(unread(db)).toEqual([]);
        expect(db.decidePendingConfirmation('a1', 'approved', { via: 'chat' })).toBeNull();
    });

    test('a card that ran out of time stops asking', () => {
        ask(db, 'a1', { expiresAt: new Date(Date.now() - 1000).toISOString() });
        notify(db, 'n1', 'a1');
        const swept = db.expirePendingConfirmations();
        expect(swept.map(r => r.id)).toEqual(['a1']);
        expect(unread(db)).toEqual([]);
    });

    test('a card dropped for a newer one stops asking', () => {
        ask(db, 'a1');
        notify(db, 'n1', 'a1');
        // What _supersede does when the same action asks again.
        db.decidePendingConfirmation('a1', 'expired', { via: 'superseded' });
        expect(unread(db)).toEqual([]);
    });

    test('the ones already in his database are cleared at boot, and pending ones are not', () => {
        ask(db, 'decided');
        ask(db, 'still-waiting');
        notify(db, 'n-decided', 'decided');
        notify(db, 'n-waiting', 'still-waiting');
        notify(db, 'n-deleted', 'a-row-that-was-cleaned-up');
        // Decide it behind the hook's back, as an older release would have left it.
        db.db.prepare("UPDATE pending_confirmations SET status = 'approved' WHERE id = 'decided'").run();
        db.db.prepare('UPDATE notifications SET is_read = 0').run();
        db.close();

        const reopened = new AgentDB(dir);
        try {
            expect(unread(reopened)).toEqual(['n-waiting']);
        } finally {
            reopened.close();
        }
        db = new AgentDB(dir);
    });

    test('a notification of another kind is never touched', () => {
        ask(db, 'a1');
        notify(db, 'n1', 'a1');
        db.createNotification({
            id: 'other', type: 'loop_detected', severity: 'warning',
            title: 'Possible tool loop', message: 'runShellCommand', metadata: { approvalId: 'a1' }
        });
        db.decidePendingConfirmation('a1', 'approved', { via: 'chat' });
        expect(unread(db)).toEqual(['other']);
    });

    test('an answered question clears its entry too', () => {
        db.createPendingQuestion({
            id: 'q1', chatId: 'owner@s.whatsapp.net', replyChatId: 'owner@s.whatsapp.net',
            replySource: 'whatsapp', question: 'Which one?', options: [],
            expiresAt: new Date(Date.now() + 60000).toISOString()
        });
        db.createNotification({
            id: 'nq', type: 'ask_user', severity: 'info',
            title: 'Deedee has a question', message: 'Which one?', metadata: { questionId: 'q1' }
        });
        expect(unread(db)).toEqual(['nq']);
        db.closePendingQuestion('q1', 'answered', 'the first');
        expect(unread(db)).toEqual([]);
    });

    test('an answer that lands while the card is still going out is not left asking', () => {
        // The bell row is written after the card is sent. If he answers in
        // that window, or a newer card replaces this one, the row would be
        // born unread and stay that way.
        ask(db, 'a1');
        db.decidePendingConfirmation('a1', 'approved', { via: 'chat' });
        notify(db, 'n1', 'a1');
        // Nothing has settled it, because the row was written afterwards.
        expect(unread(db)).toEqual(['n1']);
        // What the service does right after creating it.
        if (db.getPendingConfirmation('a1')?.status !== 'pending') db.markApprovalNotificationsRead('a1');
        expect(unread(db)).toEqual([]);
    });

    test('the open page is told, so the count does not lag', () => {
        const told = [];
        db.onNotificationsRead = (ids) => told.push(ids);
        ask(db, 'a1');
        notify(db, 'n1', 'a1');
        db.decidePendingConfirmation('a1', 'approved', { via: 'chat' });
        expect(told).toEqual([['a1']]);

        // Nothing to clear, nothing to say.
        ask(db, 'a2');
        db.decidePendingConfirmation('a2', 'approved', { via: 'chat' });
        expect(told).toHaveLength(1);
    });
});
