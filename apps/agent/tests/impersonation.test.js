const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

// Mock Config
const config = {
    googleApiKey: 'test_key',
    interface: { on: jest.fn(), emit: jest.fn(), send: jest.fn() }
};

// Mock Dependencies
jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getTools: jest.fn().mockResolvedValue([]),
        close: jest.fn()
    }))
}));

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: {
            generateContent: jest.fn().mockResolvedValue({
                response: { text: () => "Mock Response" }
            })
        }
    }))
}), { virtual: true }); // virtual if module not found in test env

describe('Impersonation & Tone Matching', () => {
    let agent;
    let dbPath = path.join(__dirname, 'test_impersonation.db');

    beforeEach(() => {
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
        agent = new Agent({ ...config });
        agent.db = new AgentDB(dbPath);
        agent.db.init();
        agent.client = {
            models: { generateContent: jest.fn() },
            chats: {
                create: jest.fn().mockReturnValue({
                    sendMessage: jest.fn().mockResolvedValue({
                        response: {
                            candidates: [{ content: { parts: [{ text: "I'm pretending to be Diego." }] } }]
                        }
                    })
                })
            }
        };
    });

    afterEach(() => {
        agent.db.close();
        if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { recursive: true, force: true });
    });

    // Strategy: We want to spy on `getSystemInstruction` OR verify that the prompt passed to `generateContent` 
    // contains the "IMPERSONATION MODE" string.
    // Since `getSystemInstruction` is imported, mocking it is one way, but testing the side effect on the client call is better integration testing.

    test('should inject Impersonation Mode instruction for ANY message', async () => {
        const message = {
            content: 'Draft a reply to Mom',
            role: 'user',
            source: 'web',
            metadata: { chatId: 'web-session', replyMode: 'text' }
        };



        // Mock Router to return FLASH model (skipping router actual call)
        agent.router.route = jest.fn().mockResolvedValue({ model: 'FLASH', toolMode: 'NONE' });

        // Mock SmartContext
        agent.smartContext.getContext = jest.fn().mockResolvedValue([]);

        await agent.processMessage(message, jest.fn());

        // Check if chats.create was called
        expect(agent.client.chats.create).toHaveBeenCalled();
        const callArgs = agent.client.chats.create.mock.calls[0][0];
        const systemPrompt = callArgs.config.systemInstruction;

        // Verify the injected string exists
        expect(systemPrompt).toContain('=== IMPERSONATION & TONE MATCHING ===');
        expect(systemPrompt).toContain('IF you are asked to draft a message for the user');
    });


});
