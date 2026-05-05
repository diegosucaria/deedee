const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const { WhatsAppService } = require('../../interfaces/src/whatsapp'); // Mock logic maybe?
const path = require('path');
const fs = require('fs');

// Mock specific dependencies
jest.mock('../../interfaces/src/whatsapp');

describe('Message Watchers & Passive Mode', () => {
    let agent;
    let db;
    let tmpDir;
    let mockInterface; // Added for the new Agent constructor signature

    beforeAll(() => {
        tmpDir = path.join(__dirname, 'tmp_watchers_test');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
        db = new AgentDB(tmpDir); // Use fresh DB
        mockInterface = new WhatsAppService(); // Initialize mock interface
        agent = new Agent({ interface: mockInterface, db: db }); // Pass db to Agent constructor
        // Mock Generation to avoid API calls
        agent._generateStream = jest.fn().mockResolvedValue({
            candidates: [{ content: { role: 'model', parts: [{ text: 'Mock Response' }] } }],
            text: () => 'Mock Response' // Add helper method used by some paths in agent.js
        });
        // Mock Router to avoid 5s timeout
        agent.router = {
            route: jest.fn().mockResolvedValue({ model: 'FLASH', toolMode: 'STANDARD' })
        };
    });

    afterAll(() => {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        db.db.exec('DELETE FROM watchers');
        db.db.exec('DELETE FROM messages');
        if (agent.watcherLocks) agent.watcherLocks.clear();
        jest.clearAllMocks();
    });

    it('should IGNORE messages in passive mode (whatsapp:user) if no watcher matches', async () => {
        // Setup Spy
        const toolSpy = jest.spyOn(agent, '_executeTool');

        const message = {
            id: 'msg_1',
            role: 'user',
            content: 'Hello world',
            source: 'whatsapp:user',
            metadata: { phoneNumber: '1234567890' }
        };

        const result = await agent.processMessage(message, async () => { });

        // Should return a summary but NO replies and NO tool execution (unless implied by processing?)
        // In the code (agent.js view), if isUserSession && !triggeredWatcher, it returns executionSummary immediately for log suppression.
        // It might call saveMessage depending on config.

        // Verify _executeTool was NOT called (no LLM invocation)
        expect(toolSpy).not.toHaveBeenCalled();
    });

    it('should TRIGGER a watcher but SUPPRESS direct reply to contact', async () => {
        // Create a watcher
        const watcherName = 'Test Watcher';
        const contact = '1234567890';

        db.createWatcher({
            name: watcherName,
            contactString: contact,
            condition: "contains 'hello'",
            instruction: "Reply 'Confirmed'",
            status: 'active'
        });

        const message = {
            id: 'msg_2',
            role: 'user',
            content: 'Oh Hello there',
            source: 'whatsapp:user',
            metadata: { phoneNumber: contact, chatId: `${contact}@s.whatsapp.net` }
        };

        // Mock sendCallback
        const sendCallback = jest.fn();

        // EXECUTE
        await agent.processMessage(message, sendCallback);

        // EXPECTATIONS:
        // 1. sendCallback should NOT be called with a reply to the original user
        // OR if called, it should be the REDIRECTED one.

        expect(sendCallback).not.toHaveBeenCalled();
    });

    it('should REDIRECT watcher reply to Admin if configured', async () => {
        // Setup Admin
        const adminId = 'admin_123';
        agent.settings = { admin_chat_id: adminId };

        const contact = '9876543210';
        db.createWatcher({
            name: 'Redirect Watcher',
            contactString: contact,
            condition: "all", // any
            instruction: "Say done",
            status: 'active'
        });

        const message = {
            id: 'msg_3',
            role: 'user',
            content: 'Ping',
            source: 'whatsapp:user', // Passive
            metadata: { phoneNumber: contact, chatId: `${contact}@s.whatsapp.net` }
        };

        const sendCallback = jest.fn();

        // Mock _generateStream or similar to force a "Done" response from the "model"? 
        // Or just rely on the fact that processMessage tries to run.
        // Since we don't mock the Model generation fully here, `processMessage` might fail or return empty.
        // We need to Mock `agent.model` or `agent.generateResponse`.

        // Let's Spy on `originalSendCallback` inside the hijacked one? Hard to do.
        // We can simply check if `sendCallback` was called with the modified chatId.

        // BUT, `processMessage` needs to actually generate a reply for `sendCallback` to be hit.
        // In this test environment, `this.client` is likely real or failing if not mocked properly?
        // agent.js: `if (!this.client) ...`

        // We need to Mock `_generateStream` to return a fake response "Done".
        agent._generateStream = jest.fn().mockResolvedValue({
            candidates: [{ content: { role: 'model', parts: [{ text: 'Done' }] } }]
        });

        await agent.processMessage(message, sendCallback);

        expect(sendCallback).toHaveBeenCalled();
        const callArgs = sendCallback.mock.calls[0][0];
        expect(callArgs.metadata.chatId).toBe(adminId);
        expect(callArgs.content).toContain(`[WATCHER: ${contact}]`);
    });

    it('should COALESCE concurrent watcher triggers into one trailing rerun', async () => {
        const contact = '5551234567';
        const insert = db.createWatcher({
            name: 'Coalesce Watcher',
            contactString: contact,
            condition: 'all',
            instruction: 'Say done',
            status: 'active'
        });
        const watcherId = insert.lastInsertRowid;

        // Bypass the dynamic GoogleGenAI import — the early `if (!this.client)` block
        // in processMessage runs before the watcher logic, and the import fails under
        // jest's CJS mode. Mocking client to truthy short-circuits that init.
        agent.client = {};

        // Simulate run 1 holding the in-flight lock (we don't run a real model here —
        // we're testing the queue/coalesce semantics directly).
        const lockKey = `watcher:${watcherId}:${contact}`;
        const lockState = { rerunNeeded: false, latestMsg: null };
        agent.watcherLocks.set(lockKey, lockState);

        const baseMsg = {
            role: 'user',
            source: 'whatsapp:user',
            metadata: { phoneNumber: contact, chatId: `${contact}@s.whatsapp.net` }
        };
        const sendCallback = jest.fn();
        const generateSpy = jest.spyOn(agent, '_generateStream');

        // Two more matching messages arrive while the lock is held — both coalesce.
        await agent.processMessage({ ...baseMsg, id: 'm2', content: 'second' }, sendCallback);
        await agent.processMessage({ ...baseMsg, id: 'm3', content: 'third' }, sendCallback);

        // Neither queued message hit the model.
        expect(generateSpy).not.toHaveBeenCalled();
        expect(sendCallback).not.toHaveBeenCalled();

        // Both messages collapsed into ONE pending rerun (not two), and the latest
        // message wins — so the rerun will fire with m3, not m2.
        expect(lockState.rerunNeeded).toBe(true);
        expect(lockState.latestMsg.id).toBe('m3');

        // Both queued messages were persisted so the rerun's readChatHistory sees them.
        const storedIds = db.db.prepare('SELECT id FROM messages WHERE chat_id = ?')
            .all(`${contact}@s.whatsapp.net`).map(r => r.id);
        expect(storedIds).toEqual(expect.arrayContaining(['m2', 'm3']));

        // Each queued message is flagged so the rerun's saveMessage skips it
        // (otherwise the rerun's INSERT would violate the messages.id PRIMARY KEY,
        // crash before the watcher hijack installs, and leak an error reply
        // straight to the watched contact).
        expect(lockState.latestMsg._watcherPersisted).toBe(true);

        // Cleanup: pretend run 1 finished (the real finally block would do this).
        agent.watcherLocks.delete(lockKey);
    });

    it('should fire exactly one trailing rerun without leaking errors to the contact (end-to-end)', async () => {
        const contact = '5559876543';
        db.createWatcher({
            name: 'E2E Watcher',
            contactString: contact,
            condition: 'all',
            instruction: 'Say done',
            status: 'active'
        });

        // Stub client + library: the dynamic GoogleGenAI import fails under jest's
        // CJS mode, and chats.create is called before _generateStream so it has to
        // exist (even if its return value is never used — _generateStream is mocked).
        agent.client = { chats: { create: jest.fn().mockReturnValue({}) } };
        agent._loadClientLibrary = jest.fn().mockResolvedValue({ GoogleGenAI: class { } });

        // Run A's first model call hangs on `runAResponse` until we resolve it,
        // holding the watcher lock so the queued message can demonstrate coalescing.
        let resolveRunA;
        const runAResponse = new Promise(r => { resolveRunA = r; });
        let callCount = 0;
        agent._generateStream = jest.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return runAResponse;
            return Promise.resolve({
                candidates: [{ content: { role: 'model', parts: [{ text: 'Done' }] } }]
            });
        });

        const baseMsg = {
            role: 'user',
            source: 'whatsapp:user',
            metadata: { phoneNumber: contact, chatId: `${contact}@s.whatsapp.net` }
        };
        const sendCallback = jest.fn();

        // Fire run A — don't await; it parks on runAResponse with the lock held.
        const runA = agent.processMessage(
            { ...baseMsg, id: 'e2e-1', content: 'first' },
            sendCallback
        );

        // Yield until run A reaches the watcher block and acquires the lock.
        for (let i = 0; i < 10 && agent.watcherLocks.size === 0; i++) {
            await new Promise(r => setImmediate(r));
        }
        expect(agent.watcherLocks.size).toBe(1);

        // Two more messages arrive while the lock is held — they should coalesce.
        await agent.processMessage({ ...baseMsg, id: 'e2e-2', content: 'second' }, sendCallback);
        await agent.processMessage({ ...baseMsg, id: 'e2e-3', content: 'third' }, sendCallback);
        expect(callCount).toBe(1); // queued messages didn't reach the model

        // Release run A; the finally block fires the rerun via setImmediate.
        resolveRunA({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done' }] } }] });
        await runA;

        // Drain enough ticks for the rerun's full flow to complete.
        for (let i = 0; i < 20 && callCount < 2; i++) {
            await new Promise(r => setImmediate(r));
        }

        // Exactly one trailing rerun fired (m2 and m3 collapsed into one).
        expect(callCount).toBe(2);

        // Lock fully released after both runs.
        expect(agent.watcherLocks.size).toBe(0);

        // CRITICAL: no error reply leaked to the contact. Without the
        // _watcherPersisted guard, the rerun's saveMessage would have thrown
        // a UNIQUE constraint error before the watcher hijack installed,
        // sending a "⚠️ A temporary processing error..." through the
        // original (un-hijacked) send callback to the watched contact.
        const errorReplies = sendCallback.mock.calls.filter(args => {
            const reply = args[0];
            return typeof reply?.content === 'string' && reply.content.startsWith('⚠️');
        });
        expect(errorReplies).toEqual([]);
    });

    // Validating specific regex logic from agent.js
    it('should match conditions correctly', () => {
        const check = (condition, content) => {
            const msgContent = content.toLowerCase();
            // Logic from agent.js
            if (condition.startsWith('contains')) {
                const keyword = condition.match(/['"](.*?)['"]/)?.[1];
                return keyword && msgContent.includes(keyword.toLowerCase());
            }
            return msgContent.includes(condition.toLowerCase());
        };

        expect(check("contains 'dinner'", "What about Dinner?")).toBe(true);
        expect(check("contains 'dinner'", "Lunch time")).toBe(false);
        expect(check("emergency", "This is an EMERGENCY")).toBe(true);
    });
});
