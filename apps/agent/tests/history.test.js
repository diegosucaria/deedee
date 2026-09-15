const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

describe('Chat History Operations', () => {
    let db;
    let dbPath;

    beforeEach(() => {
        // Use a temporary DB Directory
        dbPath = path.join(__dirname, 'test-history-db');
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
        db = new AgentDB(dbPath);
    });

    afterEach(() => {
        try {
            if (db) db.close();
        } catch (e) {
            console.error('Error closing DB:', e);
        }
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
    });

    it('should fork a session and copy messages up to a point', () => {
        const chatId = 'session-1';
        db.createSession({ id: chatId, title: 'Original Session' });

        // Insert messages
        // 1. User
        db.saveMessage({
            id: 'msg-1', role: 'user', content: 'Hello',
            chat_id: chatId, timestamp: 1000
        });
        // 2. Assistant
        db.saveMessage({
            id: 'msg-2', role: 'assistant', content: 'Hi there',
            chat_id: chatId, timestamp: 2000
        });
        // 3. User (Target for Fork)
        db.saveMessage({
            id: 'msg-3', role: 'user', content: 'Tell me a joke',
            chat_id: chatId, timestamp: 3000
        });
        // 4. Assistant (Should NOT be copied)
        db.saveMessage({
            id: 'msg-4', role: 'assistant', content: 'Why did the chicken cross the road?',
            chat_id: chatId, timestamp: 4000
        });

        // Fork at msg-3
        const newSessionId = db.forkSession(chatId, 'msg-3');

        // Verify new session
        const newSession = db.getSession(newSessionId);
        expect(newSession).toBeTruthy();
        expect(newSession.title).toBe('Original Session (Fork)');

        // Verify messages in new session
        const newMessages = db.getHistory({ chatId: newSessionId, order: 'ASC' });
        expect(newMessages.length).toBe(3);

        // Check content
        expect(newMessages[0].content).toBe('Hello');
        expect(newMessages[1].content).toBe('Hi there');
        expect(newMessages[2].content).toBe('Tell me a joke');

        // Should NOT have msg-4
        const hasMsg4 = newMessages.some(m => m.content === 'Why did the chicken cross the road?');
        expect(hasMsg4).toBe(false);
    });

    it('should perform rewind (delete messages from point)', () => {
        const chatId = 'session-rewind';
        db.createSession({ id: chatId, title: 'Rewind Test' });

        const baseTime = Date.now();

        const msgs = [
            { id: 'm1', role: 'user', content: '1', chat_id: chatId, timestamp: baseTime },
            { id: 'm2', role: 'assistant', content: '2', chat_id: chatId, timestamp: baseTime + 100 },
            { id: 'm3', role: 'user', content: '3', chat_id: chatId, timestamp: baseTime + 200 },
            { id: 'm4', role: 'assistant', content: '4', chat_id: chatId, timestamp: baseTime + 300 }
        ];

        msgs.forEach(m => db.saveMessage(m));

        // Rewind at m3 (should delete m3 and m4)
        const count = db.deleteMessagesFrom(chatId, 'm3');

        expect(count).toBe(2); // m3 and m4 deleted

        const remaining = db.getHistory({ chatId, order: 'ASC' });
        expect(remaining.length).toBe(2);
        expect(remaining[0].id).toBe('m1');
        expect(remaining[1].id).toBe('m2');
    });
});

describe('getHistoryForChat hydration', () => {
    let db;
    let dbPath;

    beforeEach(() => {
        dbPath = path.join(__dirname, 'test-hydration-db');
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
        db = new AgentDB(dbPath);
        jest.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        try { if (db) db.close(); } catch (e) { /* ignore */ }
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
    });

    it('keeps tool parts and ISO timestamps', () => {
        const chatId = 'chat-tools';
        db.createSession({ id: chatId, title: 'Tools' });
        db.saveMessage({ id: 'u1', role: 'user', content: 'weather?', chat_id: chatId, timestamp: 1000 });
        db.saveMessage({
            id: 'm1', role: 'model', chat_id: chatId, timestamp: 2000,
            parts: [{ functionCall: { name: 'getWeather', args: { city: 'X' } } }]
        });
        db.saveMessage({
            id: 'f1', role: 'function', chat_id: chatId, timestamp: 3000,
            parts: [{ functionResponse: { name: 'getWeather', response: { temp: 20 } } }]
        });
        db.saveMessage({ id: 'a1', role: 'assistant', content: 'It is 20 degrees.', chat_id: chatId, timestamp: 4000 });

        const history = db.getHistoryForChat(chatId, 20);
        expect(history.map(m => m.id)).toEqual(['u1', 'm1', 'f1', 'a1']);
        expect(history.map(m => m.role)).toEqual(['user', 'model', 'user', 'model']);
        expect(history[1].parts[0].functionCall.name).toBe('getWeather');
        expect(history[2].parts[0].functionResponse.response.temp).toBe(20);
        expect(history[3].parts[0].text).toBe('It is 20 degrees.');
        expect(history[0].timestamp).toBe(new Date(1000).toISOString());
        expect(history[0].metadata).toEqual({});
        for (const m of history) {
            expect(Object.keys(m).sort()).toEqual(['id', 'metadata', 'parts', 'role', 'timestamp']);
        }
    });

    it('restores the caption of a media row whose parts hold only the file', () => {
        const chatId = 'chat-media';
        db.createSession({ id: chatId, title: 'Media' });
        db.saveMessage({
            id: 'img1', role: 'user', content: 'what is this?', chat_id: chatId, timestamp: 1000,
            parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }]
        });
        db.saveMessage({
            id: 'fc1', role: 'model', content: 'Thinking...', chat_id: chatId, timestamp: 2000,
            parts: [{ functionCall: { name: 'lookup', args: {} } }]
        });
        const history = db.getHistoryForChat(chatId, 20);
        expect(history[0].parts[0]).toEqual({ text: 'what is this?' });
        expect(history[0].parts[1].inlineData.mimeType).toBe('image/jpeg');
        // Tool rows never get their content text added.
        expect(history[1].parts).toHaveLength(1);
        expect(history[1].parts[0].functionCall.name).toBe('lookup');
    });

    it('keeps insertion order for rows saved in the same millisecond', () => {
        const chatId = 'chat-same-ms';
        db.createSession({ id: chatId, title: 'Same ms' });
        const ts = '2026-01-01T00:00:00.000Z';
        db.saveMessage({ id: 'a', role: 'user', content: 'first', chat_id: chatId, timestamp: ts });
        db.saveMessage({ id: 'b', role: 'model', chat_id: chatId, timestamp: ts, parts: [{ functionCall: { name: 't', args: {} } }] });
        db.saveMessage({ id: 'c', role: 'function', chat_id: chatId, timestamp: ts, parts: [{ functionResponse: { name: 't', response: {} } }] });
        db.saveMessage({ id: 'd', role: 'assistant', content: 'done', chat_id: chatId, timestamp: ts });

        expect(db.getHistoryForChat(chatId, 20).map(m => m.id)).toEqual(['a', 'b', 'c', 'd']);
        // The limit still keeps the newest rows.
        expect(db.getHistoryForChat(chatId, 2).map(m => m.id)).toEqual(['c', 'd']);
    });

    it('counts messages after a given message', () => {
        const chatId = 'chat-count';
        db.createSession({ id: chatId, title: 'Count' });
        const ts = '2026-01-01T00:00:00.000Z';
        db.saveMessage({ id: 'a', role: 'user', content: '1', chat_id: chatId, timestamp: ts });
        db.saveMessage({ id: 'b', role: 'assistant', content: '2', chat_id: chatId, timestamp: ts });
        db.saveMessage({ id: 'c', role: 'user', content: '3', chat_id: chatId, timestamp: '2026-01-01T00:00:01.000Z' });

        expect(db.countMessagesAfter(chatId, 'a')).toBe(2);
        expect(db.countMessagesAfter(chatId, 'c')).toBe(0);
        expect(db.countMessagesAfter(chatId, 'missing')).toBeNull();
    });

    it('converts integer timestamps to ISO text once', () => {
        const chatId = 'chat-migrate';
        db.createSession({ id: chatId, title: 'Migrate' });
        const insertRaw = db.db.prepare('INSERT INTO messages (id, role, content, chat_id, timestamp) VALUES (?, ?, ?, ?, ?)');
        insertRaw.run('old-1', 'user', 'old', chatId, 1700000000000);
        insertRaw.run('old-2', 'assistant', 'older reply', chatId, 1700000001000);
        db.saveMessage({ id: 'new-1', role: 'user', content: 'new', chat_id: chatId, timestamp: '2026-01-01T00:00:00.000Z' });

        // Before the migration the integer rows sort after the text row.
        db.db.prepare('DELETE FROM agent_settings WHERE key = ?').run('migration_messages_ts_iso');
        db._migrateMessageTimestampsToIso();

        const rows = db.db.prepare('SELECT id, timestamp, typeof(timestamp) as t FROM messages WHERE chat_id = ? ORDER BY timestamp').all(chatId);
        expect(rows.map(r => r.t)).toEqual(['text', 'text', 'text']);
        expect(rows.map(r => r.id)).toEqual(['old-1', 'old-2', 'new-1']);
        expect(rows[0].timestamp).toBe(new Date(1700000000000).toISOString());
        expect(db.getAgentSetting('migration_messages_ts_iso')).not.toBeNull();

        // A second call is a no-op: the flag is set, so a fresh integer row stays as is.
        insertRaw.run('old-3', 'user', 'late', chatId, 1700000002000);
        db._migrateMessageTimestampsToIso();
        const late = db.db.prepare('SELECT typeof(timestamp) as t FROM messages WHERE id = ?').get('old-3');
        expect(late.t).toBe('integer');
    });
});
