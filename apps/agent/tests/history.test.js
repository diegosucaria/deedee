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
