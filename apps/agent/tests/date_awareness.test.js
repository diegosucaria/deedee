const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');

// Mock Dependencies
jest.mock('../src/db', () => ({
    AgentDB: jest.fn().mockImplementation(() => ({
        getPendingGoals: jest.fn().mockReturnValue([]),
        getHistoryForChat: jest.fn().mockReturnValue([]),
        getScheduledJobs: jest.fn().mockReturnValue([]),
        saveScheduledJob: jest.fn(),
        deleteScheduledJob: jest.fn(),
        saveMessage: jest.fn(),
        logMetric: jest.fn(),
        logTokenUsage: jest.fn(),
        checkLimit: jest.fn().mockReturnValue(true),
        logUsage: jest.fn(),
        getAllFacts: jest.fn().mockReturnValue([]),
        getFactsFormatted: jest.fn().mockReturnValue(''), // Added
        saveSummary: jest.fn(),
        getLatestSummary: jest.fn().mockReturnValue(null),
        searchMessages: jest.fn().mockReturnValue([]),
        deleteJobState: jest.fn(),
        getKey: jest.fn(),
        close: jest.fn()
    }))
}));

jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getTools: jest.fn().mockResolvedValue([]),
        callTool: jest.fn(),
        close: jest.fn().mockResolvedValue()
    }))
}));

jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({
    GSuiteTools: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('@deedee/mcp-servers/src/local/index', () => ({
    LocalTools: jest.fn().mockImplementation(() => ({}))
}));

// Mock Google GenAI
const mockChatsCreate = jest.fn().mockReturnValue({
    sendMessage: jest.fn().mockResolvedValue({
        text: () => "I know the date.",
        candidates: [{ content: { parts: [{ text: "I know the date." }] } }]
    })
});

const mockGoogleGenAI = jest.fn().mockImplementation(() => ({
    chats: {
        create: mockChatsCreate
    }
}));

describe('Date Awareness', () => {
    let agent;
    let mockInterface;

    beforeEach(() => {
        jest.clearAllMocks();
        mockInterface = new MockInterface();
        agent = new Agent({
            googleApiKey: 'fake-key',
            interface: mockInterface
        });

        // Inject Mock Client
        agent._loadClientLibrary = jest.fn().mockResolvedValue({
            GoogleGenAI: mockGoogleGenAI
        });
        // Router Mock
        agent.router._loadClientLibrary = jest.fn().mockResolvedValue({
            GoogleGenAI: mockGoogleGenAI
        });
        // Bypass router execution
        agent.router.route = jest.fn().mockResolvedValue({ model: 'FLASH', reason: 'Test' });

        // Force fix for missing mocks
        if (agent.mcp) agent.mcp.close = jest.fn().mockResolvedValue();
        if (agent.db) {
            agent.db.deleteJobState = jest.fn();
            agent.db.deleteScheduledJob = jest.fn();
        }
    });

    afterEach(async () => {
        if (agent) await agent.stop();
    });

    test('should inject CURRENT_TIME into system instruction', async () => {
        await agent.start();

        // Trigger onMessage to force session creation
        await agent.onMessage({ content: 'What time is it?', source: 'telegram' });

        // Verify session creation args
        expect(mockChatsCreate).toHaveBeenCalled();
        const config = mockChatsCreate.mock.calls[0][0]; // First call, first arg (config)

        const systemInstruction = config.config.systemInstruction;
        expect(systemInstruction).toContain('CURRENT_TIME:');

        // Verify it has the year (good enough for sanity check)
        const year = new Date().getFullYear().toString();
        expect(systemInstruction).toContain(year);
    });
});
