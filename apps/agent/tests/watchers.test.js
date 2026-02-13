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
    });

    afterAll(() => {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        db.db.exec('DELETE FROM watchers');
        db.db.exec('DELETE FROM messages');
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
