const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');
const { createUserMessage } = require('@deedee/shared/src/types');

// Mock partial DB
const mockClearHistory = jest.fn();
const mockClearGoals = jest.fn();
const mockSaveMessage = jest.fn();

jest.mock('../src/db', () => ({
    AgentDB: jest.fn().mockImplementation(() => ({
        clearHistory: mockClearHistory,
        clearGoals: mockClearGoals,
        saveMessage: mockSaveMessage,
        migrateSessionId: jest.fn().mockReturnValue({ session: 1, messages: 10, summaries: 0, token_usage: 0 }),
        // Add other methods called in constructor or start() if needed
        // But since we only test onMessage logic for commands, mostly fine.
        // Agent constructor inits Router/MCP, we need to mock them too or handle them.
        getKey: jest.fn(),
        addGoal: jest.fn(),
        updateGoal: jest.fn(),
        deleteGoal: jest.fn(),
        getAllAgentSettings: jest.fn().mockReturnValue({}),
        checkLimit: jest.fn().mockReturnValue(true),
        getPendingGoals: jest.fn().mockReturnValue([]), // Added
        logUsage: jest.fn(),
        logMetric: jest.fn(),
        logTokenUsage: jest.fn(),
        getHistoryForChat: jest.fn().mockReturnValue([]),
        getAllFacts: jest.fn().mockReturnValue([]),
        saveSummary: jest.fn(),
        getLatestSummary: jest.fn().mockReturnValue(null),
        searchMessages: jest.fn().mockReturnValue([]),
        deleteMessagesSince: jest.fn(), // Added
        ensureSession: jest.fn(), // Added
        countMessages: jest.fn().mockReturnValue(10), // Should be > 0 to avoid auto-title trigger in tests
        close: jest.fn()
    }))
}));

// Mock Router
jest.mock('../src/router', () => ({
    Router: jest.fn().mockImplementation(() => ({
        route: jest.fn().mockResolvedValue({ model: 'FLASH' })
    }))
}));

// Mock MCP
jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getTools: jest.fn().mockResolvedValue([]),
        close: jest.fn().mockResolvedValue()
    }))
}));

// Mock Local/GSuite Tools to avoid loading them
jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({ GSuiteTools: jest.fn() }));
jest.mock('@deedee/mcp-servers/src/local/index', () => ({ LocalTools: jest.fn() }));

describe('Slash Commands', () => {
    let agent;
    let mockInterface;

    beforeEach(() => {
        jest.clearAllMocks();
        mockInterface = new MockInterface();
        agent = new Agent({
            googleApiKey: 'fake',
            interface: mockInterface
        });
        // We mock _loadClientLibrary to avoid real import
        agent.router._loadClientLibrary = jest.fn().mockResolvedValue({ GoogleGenAI: class { } });

        // Force fix for mcp.close
        if (agent.mcp) {
            agent.mcp.close = jest.fn().mockResolvedValue();
        }
    });

    afterEach(async () => {
        if (agent) await agent.stop();
    });

    test('/clear should call db.clearHistory', async () => {
        const msg = createUserMessage('/clear', 'telegram', 'user1');
        msg.metadata = { chatId: 'chat123' };

        await agent.onMessage(msg);

        expect(mockClearHistory).toHaveBeenCalledWith('chat123');
        expect(mockInterface.getLastMessage().content).toBe('Current chat history cleared.');
        // Should NOT save message (it's a command)
        expect(mockSaveMessage).not.toHaveBeenCalled();
    });

    test('/reset_goals should call db.clearGoals', async () => {
        const msg = createUserMessage('/reset_goals', 'telegram', 'user1');
        msg.metadata = { chatId: 'chat123' };

        await agent.onMessage(msg);

        expect(mockClearGoals).toHaveBeenCalledWith('chat123');
        expect(mockInterface.getLastMessage().content).toContain('goals reset');
    });

    test('/migrate_chat_id should call db.migrateSessionId', async () => {
        const msg = createUserMessage('/migrate_chat_id old_id new_id', 'telegram', 'user1');
        msg.metadata = { chatId: 'chat123' };

        await agent.onMessage(msg);

        // We access the mock instance via usage in db factory
        // But mock is returned by factory.
        // We can access via agent.db which is standard assignment in Agent
        expect(agent.db.migrateSessionId).toHaveBeenCalledWith('old_id', 'new_id');
        expect(mockInterface.getLastMessage().content).toContain('Migration Successful');
    });

    test('/migrate_chat_id should auto-generate newId if missing', async () => {
        const msg = createUserMessage('/migrate_chat_id old_encoded_id', 'telegram', 'user1');
        msg.metadata = { chatId: 'chat123' };

        await agent.onMessage(msg);

        // Verify it was called with oldId and SOME new UUID
        expect(agent.db.migrateSessionId).toHaveBeenCalledWith(
            'old_encoded_id',
            expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
        );
        expect(mockInterface.getLastMessage().content).toContain('Migration Successful');
        expect(mockInterface.getLastMessage().content).toContain('New ID:');
    });

    test('Regular message should save to DB', async () => {
        const msg = createUserMessage('Hello', 'telegram', 'user1');
        msg.metadata = { chatId: 'chat123' };

        // Mock start/client to avoid crashes further down
        agent.client = {
            chats: {
                create: jest.fn().mockReturnValue({
                    sendMessage: jest.fn().mockResolvedValue({
                        candidates: [{ content: { parts: [{ text: 'Mock Response' }] } }]
                    })
                })
            }
        };
        // We only care that it passed the command check
        try {
            await agent.onMessage(msg);
        } catch (e) {
            // It might fail on Router/Gemini, but that's fine.
            // We just check if saveMessage was called BEFORE that.
        }

        expect(mockSaveMessage).toHaveBeenCalled();
    });
});
