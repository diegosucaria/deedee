const { describe, expect, test, beforeEach, afterEach } = require('@jest/globals');
const { AgentDB } = require('../src/db.js');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');


describe('Pinned Chats Feature', () => {
    let db;

    beforeEach(() => {
        // Mock DATA_DIR
        process.env.DATA_DIR = __dirname;

        // Manual instantiation to control path
        if (!fs.existsSync(__dirname)) fs.mkdirSync(__dirname);

        // Instantiate DB but force path
        // We can't easily force path in constructor without mocking path or process.env which we did.
        // But constructor makes 'agent.db'. We want 'test_pinned.db'.
        // So we just override it after creation? No, it opens in constructor.
        // constructor(dataDir) uses dataDir/agent.db
        // Let's make a subdir for test
        testDir = path.join(__dirname, 'test_db_dir');
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });

        db = new AgentDB(testDir);
    });

    afterEach(() => {
        // Close the database connection after each test
        if (db) {
            db.close();
        }
        // Remove the test directory after each test
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    // afterAll is not strictly needed if afterEach cleans up,
    // but it's good practice for final cleanup or if afterEach fails.
    // However, since db is re-instantiated in beforeEach and closed in afterEach,
    // an afterAll for db.close() is redundant here.
    // The original instruction implied adding an afterAll to close db,
    // but given the beforeEach/afterEach structure, closing in afterEach is more appropriate.
    // If we were to add an afterAll, it would look like this:
    /*
    afterAll(() => {
        // Ensure any lingering DB connections are closed, though afterEach should handle it.
        // And ensure the directory is removed one last time.
        if (db) db.close(); // This 'db' might be the last one from the last test.
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });
    */

    test('should assist updateSession with isPinned', () => {
        const id = 'chat-1';
        db.createSession({ id, title: 'Chat 1' });

        let session = db.getSession(id);
        expect(session.is_pinned).toBe(0);

        db.updateSession(id, { isPinned: true });
        session = db.getSession(id);
        expect(session.is_pinned).toBe(1);

        db.updateSession(id, { isPinned: false });
        session = db.getSession(id);
        expect(session.is_pinned).toBe(0);
    });

    test('should sort pinned sessions first', () => {
        const id1 = '1-1';
        const id2 = '2-2';
        const id3 = '3-3';

        // Mock DB calls don't let us easily set created_at/updated_at in createSession
        // But we can direct SQL update.

        db.createSession({ id: id1, title: 'Normal 1' });
        db.createSession({ id: id2, title: 'Pinned 1' });
        db.createSession({ id: id3, title: 'Normal 2' });

        // Manually space out updated_at to ensure deterministic sort if seconds are same
        db.db.prepare("UPDATE chat_sessions SET updated_at = datetime('now', '-10 minutes') WHERE id = ?").run(id1);
        db.db.prepare("UPDATE chat_sessions SET updated_at = datetime('now', '-5 minutes') WHERE id = ?").run(id2);
        db.db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?").run(id3);

        // Now Pin id2. This also updates its updated_at to NOW in the code usually.
        // updateSession sets updated_at = CURRENT_TIMESTAMP.
        // So id2 will be NOW. id3 is NOW. 
        // We want to test pinned explicit sort.

        db.updateSession(id2, { isPinned: true });

        // id2 is Pinned (1) and updated_at (NOW)
        // id3 is Unpinned (0) and updated_at (NOW)
        // id1 is Unpinned (0) and updated_at (-10 min)

        // Pinned (id2) should be first regardless of time? Yes order by is_pinned DESC.

        const sessions = db.getSessions();
        expect(sessions[0].id).toBe(id2);
        expect(sessions[0].is_pinned).toBe(1);

        // Between id3 and id1: id3 is newer users updated_at DESC.
        expect(sessions[1].id).toBe(id3);
        expect(sessions[2].id).toBe(id1);
    });
});
