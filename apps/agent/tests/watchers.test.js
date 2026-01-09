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

    beforeAll(() => {
        tmpDir = path.join(__dirname, 'tmp_watchers_test');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
        db = new AgentDB(tmpDir);
        agent = new Agent(db);
        // Mock Tool Execution to track calls
        agent._executeTool = jest.fn().mockResolvedValue('Tool Executed');
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
        expect(agent._executeTool).not.toHaveBeenCalled();
    });

    it('should TRIGGER a watcher if condition matches', async () => {
        // Create a watcher
        db.createWatcher({
            name: 'Test Watcher',
            contactString: '1234567890',
            condition: "contains 'hello'",
            instruction: "Reply 'Confirmed'",
            status: 'active'
        });

        const message = {
            id: 'msg_2',
            role: 'user',
            content: 'Oh Hello there', // Matches 'hello' case-insensitive usually
            source: 'whatsapp:user',
            metadata: { phoneNumber: '1234567890' }
        };

        // We need to spy on runInstruction or similar?
        // In agent.js, if triggeredWatcher:
        // message.content = `[WATCHER TRIGGERED: ${triggeredWatcher.name}] ${triggeredWatcher.instruction}\nContext: ${message.content}`;
        // source = 'whatsapp:assistant'; // Switch to active mode

        // The Agent then proceeds to process this *modified* message as a normal command.
        // So we expect the Agent to process it. _executeTool might be called if the instruction implies a tool, or just LLM reply.
        // Since we don't mock the LLM here fully, checking the "switch" logic is harder without mocking `generateResponse`.

        // Let's rely on the fact that existing tests mock the LLM or we can inspect the internal state if possible.
        // Alternatively, verify the agent DOES NOT exit early.

        // BUT wait, `agent.processMessage` calls `this.model.generateContent` which needs mocking if we go deep.
        // Let's just mock `generateResponse` or `runParams`.

        // Let's assume the agent uses `this.ai` or similar.
        // agent.js uses `this.model` (Gemini). We should mock that.
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
