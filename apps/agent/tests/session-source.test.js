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
            .run('C0EXAMPLE02', 'Vinyl Duplicate Check', '2026-09-22T14:01:56.000Z', '2026-09-22T14:01:56.000Z');
        saveUserMessage('C0EXAMPLE02', 'web');

        expect(db.backfillSessionSources()).toBe(1);
        expect(db.getSession('C0EXAMPLE02').source).toBe('web');
        expect(db.getSessions({ limit: 50 }).map(s => s.id)).toContain('C0EXAMPLE02');
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
