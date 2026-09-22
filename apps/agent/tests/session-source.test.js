const { AgentDB } = require('../src/db');
const fs = require('fs');
const path = require('path');
const os = require('os');

// The fault: a web chat was written into a Slack channel's session, because
// "New Chat" reused any empty session and the sidebar listed sessions by the
// shape of their id. The chat then vanished from the list.
describe('Chat session ownership', () => {
    let db;
    let tmpDir;

    const saveUserMessage = (chatId, source) => db.saveMessage({
        role: 'user', content: 'hello', source, chatId
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-test-'));
        db = new AgentDB(tmpDir);
    });

    afterEach(() => {
        if (db) db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.SESSION_SOURCE_FILTER;
    });

    test('a Slack channel Deedee only listened to is never reused as a new web chat', () => {
        db.ensureSession('C0EXAMPLE01', 'slack');
        expect(db.getLatestEmptySession()).toBeNull();
    });

    test('an empty web chat is still reused', () => {
        const web = db.createSession({ id: undefined, title: 'New Chat', source: 'web' });
        expect(db.getLatestEmptySession().id).toBe(web.id);
    });

    test('the list holds web chats and drops every other interface', () => {
        const web = db.createSession({ title: 'New Chat', source: 'web' });
        db.ensureSession('C0EXAMPLE01', 'slack');
        db.ensureSession('100000000000001@g.us', 'whatsapp');
        db.ensureSession('123456789', 'telegram');
        db.ensureSession('scheduled_morning_briefing_1', 'scheduler');
        db.ensureSession('subagent-sub-abc', 'subagent');

        const ids = db.getSessions({ limit: 50 }).map(s => s.id);
        expect(ids).toEqual([web.id]);
    });

    test('a web chat holding a Slack channel id is listed again', () => {
        // What the bug left behind: a session keyed by a Slack channel id whose
        // messages all came from the dashboard.
        db.db.prepare(`INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run('C0EXAMPLE02', 'A Chat From The Dashboard', '2026-09-22T14:01:56.000Z', '2026-09-22T14:01:56.000Z');
        saveUserMessage('C0EXAMPLE02', 'web');

        expect(db.backfillSessionSources()).toBe(1);
        expect(db.getSession('C0EXAMPLE02').source).toBe('web');
        expect(db.getSessions({ limit: 50 }).map(s => s.id)).toContain('C0EXAMPLE02');
    });

    test('a legacy row with an integer timestamp does not mislabel a web chat', () => {
        // messages.timestamp holds ISO text and, in old rows, integer
        // milliseconds. SQLite sorts the two apart, so the backfill counts
        // the sources instead of reading the first row.
        db.db.prepare(`INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run('C0EXAMPLE05', 'A Chat From The Dashboard', '2026-09-22T14:01:56.000Z', '2026-09-22T14:01:56.000Z');
        db.db.prepare(`INSERT INTO messages (id, role, content, source, chat_id, timestamp) VALUES (?, 'user', 'hi', 'slack', ?, 1600000000000)`)
            .run('m-int-1', 'C0EXAMPLE05');
        saveUserMessage('C0EXAMPLE05', 'web');
        saveUserMessage('C0EXAMPLE05', 'web');

        db.backfillSessionSources();
        expect(db.getSession('C0EXAMPLE05').source).toBe('web');
    });

    test('an assistant reply keeping the default source does not hide a chat', () => {
        db.db.prepare(`INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run('4b30dea9-1b20-5bb4-9a58-000000000005', 'Old Chat', '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z');
        db.saveMessage({ role: 'assistant', content: 'hi', source: 'system', chatId: '4b30dea9-1b20-5bb4-9a58-000000000005' });

        db.backfillSessionSources();
        expect(db.getSession('4b30dea9-1b20-5bb4-9a58-000000000005').source).toBe('web');
    });

    test('a chat you named keeps its row when it holds no messages', () => {
        // /clear empties a chat. The cleanup must not take the chat with it.
        const cleared = db.createSession({ id: 'cleared-1', title: 'Holiday Plans', source: 'web' });
        db.db.prepare('UPDATE chat_sessions SET created_at = ? WHERE id = ?')
            .run('2020-01-01T00:00:00.000Z', cleared.id);

        db.deleteEmptySessions('some-other-chat');
        expect(db.getSession(cleared.id)).toBeTruthy();
    });

    test('the backfill leaves a real Slack chat out of the web list', () => {
        db.db.prepare(`INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run('C0EXAMPLE03', 'New Chat', '2026-09-22T14:01:56.000Z', '2026-09-22T14:01:56.000Z');
        saveUserMessage('C0EXAMPLE03', 'slack');

        db.backfillSessionSources();
        expect(db.getSession('C0EXAMPLE03').source).toBe('slack');
        expect(db.getSessions({ limit: 50 }).map(s => s.id)).not.toContain('C0EXAMPLE03');
    });

    test('an empty legacy session with a dash in its id stays visible', () => {
        db.db.prepare(`INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run('4b30dea9-1b20-5bb4-9a58-000000000001', 'Older Chat', '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z');

        db.backfillSessionSources();
        expect(db.getSessions({ limit: 50 }).map(s => s.id)).toContain('4b30dea9-1b20-5bb4-9a58-000000000001');
    });

    test('a WhatsApp chat stays hidden even when its first saved message says web', () => {
        db.db.prepare(`INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
            .run('100000000000001@g.us', 'WhatsApp Chat', '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z');
        saveUserMessage('100000000000001@g.us', 'web');

        db.backfillSessionSources();
        expect(db.getSession('100000000000001@g.us').source).toBe('whatsapp');
        expect(db.getSessions({ limit: 50 }).map(s => s.id)).not.toContain('100000000000001@g.us');
    });

    test('a chat from a phone shortcut stays in the list', () => {
        // Sources we do not know name the owner's own chat, not an interface
        // with a list of its own, so they must not drop out of the sidebar.
        db.ensureSession('4b30dea9-1b20-5bb4-9a58-000000000002', 'ios_shortcut');
        expect(db.getSessions({ limit: 50 }).map(s => s.id))
            .toContain('4b30dea9-1b20-5bb4-9a58-000000000002');
    });

    test('a row the backfill never reached keeps the old id rule', () => {
        db.db.prepare(`INSERT INTO chat_sessions (id, title, source, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`)
            .run('4b30dea9-1b20-5bb4-9a58-000000000003', 'Never Backfilled', '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z');
        db.db.prepare(`INSERT INTO chat_sessions (id, title, source, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`)
            .run('100000000000002@g.us', 'WhatsApp Chat', '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z');

        const ids = db.getSessions({ limit: 50 }).map(s => s.id);
        expect(ids).toContain('4b30dea9-1b20-5bb4-9a58-000000000003');
        expect(ids).not.toContain('100000000000002@g.us');
    });

    test('an empty chat made minutes ago is cleaned up', () => {
        // The cutoff used datetime('now'), which SQLite compares as text
        // against an ISO created_at and always reads as smaller, so nothing
        // made the same day was ever deleted.
        const stay = db.createSession({ title: 'New Chat', source: 'web' });
        const go = db.createSession({ id: 'gone-1', title: 'New Chat', source: 'web' });
        db.db.prepare('UPDATE chat_sessions SET created_at = ? WHERE id = ?')
            .run(new Date(Date.now() - 30 * 60000).toISOString(), 'gone-1');

        db.deleteEmptySessions(stay.id);
        expect(db.getSession('gone-1')).toBeUndefined();
        expect(db.getSession(stay.id)).toBeTruthy();
    });

    test('an empty chat made seconds ago survives the cleanup', () => {
        const stay = db.createSession({ title: 'New Chat', source: 'web' });
        const fresh = db.createSession({ id: 'fresh-1', title: 'New Chat', source: 'web' });
        db.deleteEmptySessions(stay.id);
        expect(db.getSession(fresh.id)).toBeTruthy();
    });

    test('a chat that holds messages is never cleaned up', () => {
        const kept = db.createSession({ id: 'kept-1', title: 'New Chat', source: 'web' });
        saveUserMessage(kept.id, 'web');
        db.db.prepare('UPDATE chat_sessions SET created_at = ? WHERE id = ?')
            .run('2020-01-01T00:00:00.000Z', kept.id);

        db.deleteEmptySessions('some-other-chat');
        expect(db.getSession(kept.id)).toBeTruthy();
    });

    test('an empty Telegram group is never handed to a new web chat', () => {
        // A Telegram group id is negative, so the dash rule used to read it
        // as a web chat.
        db.ensureSession('-1001234567890', 'telegram');
        expect(db.getLatestEmptySession()).toBeNull();
        expect(db.getSessions({ limit: 50 }).map(s => s.id)).not.toContain('-1001234567890');
    });

    test('a chat made through the API gateway stays in the list', () => {
        db.ensureSession('4b30dea9-1b20-5bb4-9a58-000000000004', 'api');
        expect(db.getSessions({ limit: 50 }).map(s => s.id))
            .toContain('4b30dea9-1b20-5bb4-9a58-000000000004');
    });

    test('a pinned empty chat survives the cleanup', () => {
        const pinned = db.createSession({ id: 'pinned-1', title: 'New Chat', source: 'web' });
        db.updateSession(pinned.id, { isPinned: true });
        db.db.prepare('UPDATE chat_sessions SET created_at = ? WHERE id = ?')
            .run('2020-01-01T00:00:00.000Z', pinned.id);

        db.deleteEmptySessions('some-other-chat');
        expect(db.getSession(pinned.id)).toBeTruthy();
    });

    test('the migration rewrites stored dates in the old format', () => {
        db.db.prepare(`INSERT INTO chat_sessions (id, title, source, created_at, updated_at) VALUES (?, ?, 'web', ?, ?)`)
            .run('legacy-1', 'Legacy Chat', '2026-05-01 10:00:00', '2026-05-01 10:00:00.500');
        db.close();

        db = new AgentDB(tmpDir); // reopening runs the migrations
        const row = db.getSession('legacy-1');
        expect(row.created_at).toBe('2026-05-01T10:00:00.000Z');
        expect(row.updated_at).toBe('2026-05-01T10:00:00.500Z');
    });

    test('SESSION_SOURCE_FILTER=0 restores the old id-shape list', () => {
        db.ensureSession('C0EXAMPLE04', 'web'); // web-owned, no dash in the id
        process.env.SESSION_SOURCE_FILTER = '0';
        expect(db.getSessions({ limit: 50 }).map(s => s.id)).not.toContain('C0EXAMPLE04');
    });

    test('a new message moves its chat to the top of the list', () => {
        const older = db.createSession({ title: 'Older Chat', source: 'web' });
        const newer = db.createSession({ title: 'Newer Chat', source: 'web' });
        // Two creates can land in the same millisecond, so set the dates apart.
        const setDate = db.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?');
        setDate.run('2026-09-20T10:00:00.000Z', older.id);
        setDate.run('2026-09-21T10:00:00.000Z', newer.id);
        expect(db.getSessions({ limit: 50 })[0].id).toBe(newer.id);

        saveUserMessage(older.id, 'web');
        expect(db.getSessions({ limit: 50 })[0].id).toBe(older.id);
    });

    test('a copied older message does not drag a live chat backwards', () => {
        const chat = db.createSession({ title: 'Live Chat', source: 'web' });
        const before = db.getSession(chat.id).updated_at;
        db.saveMessage({ role: 'user', content: 'old', source: 'web', chatId: chat.id, timestamp: '2020-01-01T00:00:00.000Z' });
        expect(db.getSession(chat.id).updated_at).toBe(before);
    });
});
