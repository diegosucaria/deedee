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
        // Add other methods called in constructor or start() if needed
        // But since we only test onMessage logic for commands, mostly fine.
        // Agent constructor inits Router/MCP, we need to mock them too or handle them.
        getKey: jest.fn(),
        addGoal: jest.fn(),
        checkLimit: jest.fn().mockReturnValue(true),
        getPendingGoals: jest.fn().mockReturnValue([]), // Added
        logUsage: jest.fn(),
        logMetric: jest.fn(),
        logTokenUsage: jest.fn(),
        getHistoryForChat: jest.fn().mockReturnValue([]),
        getAllFacts: jest.fn().mockReturnValue([])
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
        getTools: jest.fn().mockResolvedValue([])
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
        agent._loadClientLibrary = jest.fn().mockResolvedValue({
            GoogleGenAI: jest.fn().mockImplementation(() => ({}))
        });
    });

    test('/clear should call db.clearHistory', async () => {
        const msg = createUserMessage('/clear', 'telegram', 'user1');
        msg.metadata = { chatId: 'chat123' };

        await agent.onMessage(msg);

        expect(mockClearHistory).toHaveBeenCalledWith('chat123');
        expect(mockInterface.getLastMessage().content).toBe('Chat history cleared.');
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
