
const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');
const { createUserMessage } = require('@deedee/shared/src/types');

// Mock Dependencies
jest.mock('../src/db', () => ({
    AgentDB: jest.fn().mockImplementation(() => ({
        db: { prepare: jest.fn().mockReturnValue({ all: jest.fn().mockReturnValue([]) }) },
        saveMessage: jest.fn(), countMessages: jest.fn().mockReturnValue(0), ensureSession: jest.fn(),
        checkLimit: jest.fn().mockReturnValue(0), logMetric: jest.fn(), logTokenUsage: jest.fn(),
        close: jest.fn().mockResolvedValue(),
        getSession: jest.fn().mockReturnValue({ title: 'Test Chat' }),
        updateSession: jest.fn(),
        getWatchers: jest.fn().mockReturnValue([]),
        getScheduledJobs: jest.fn().mockReturnValue([]),
        getPendingGoals: jest.fn().mockReturnValue([]),
        deleteJobState: jest.fn(),
        saveScheduledJob: jest.fn(),
        deleteScheduledJob: jest.fn(),
        saveSummary: jest.fn(),
        getLatestSummary: jest.fn(),
        logUsage: jest.fn(),
        deleteMessagesSince: jest.fn(),
        getHistoryForChat: jest.fn().mockReturnValue([]),
        getAllFacts: jest.fn().mockReturnValue([]),
        getFactsFormatted: jest.fn().mockReturnValue(''),
        searchMessages: jest.fn().mockReturnValue([]),
        getKey: jest.fn(),
        setKey: jest.fn()
    }))
}));

jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({
    GSuiteTools: jest.fn().mockImplementation(() => ({ listEvents: jest.fn() }))
}));

jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(), getTools: jest.fn().mockResolvedValue([]), close: jest.fn().mockResolvedValue()
    }))
}));

// Mock GoogleGenAI with Streaming support
const MockGoogleGenAI = jest.fn().mockImplementation(() => ({
    chats: {
        create: jest.fn().mockReturnValue({
            sendMessage: jest.fn().mockResolvedValue({
                response: { candidates: [{ content: { parts: [{ text: 'Fallback response' }] } }] }
            }),
            sendMessageStream: jest.fn().mockImplementation(async (payload) => {
                // Verify payload
                if (!payload) throw new Error('Payload cannot be empty.');

                // Handle both direct content and wrapped content (legacy)
                const content = payload.message || payload;
                const textContext = typeof content === 'string' ? content : content.parts?.[0]?.text;

                const streamGenerator = async function* () {
                    yield { text: () => 'Streamed ' };
                    yield { text: () => 'Response' };
                };

                return {
                    stream: streamGenerator(),
                    response: Promise.resolve({
                        text: () => 'Streamed Response',
                        candidates: [{ content: { parts: [{ text: 'Streamed Response' }] } }]
                    })
                };
            })
        })
    }
}));

describe('Agent Streaming', () => {
    let agent;
    let mockInterface;

    beforeEach(() => {
        jest.clearAllMocks();
        mockInterface = new MockInterface();
        agent = new Agent({
            googleApiKey: 'fake-key',
            interface: mockInterface
        });

        const mockModule = { GoogleGenAI: MockGoogleGenAI };
        agent._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
        if (agent.router) {
            agent.router._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
        }

        // Mock Services to avoid Side Effects
        agent.titleService.autoTitleSession = jest.fn().mockResolvedValue();
        agent.analysisService.analyzeAttachment = jest.fn().mockResolvedValue();
    });

    afterEach(async () => {
        await agent.stop();
    });

    test('should stream tokens for web source', async () => {
        await agent.start();

        const tokens = [];
        mockInterface.on('agent:token', (data) => {
            tokens.push(data.content);
        });

        // Use 'web' source to trigger streaming
        const userMsg = createUserMessage('Hello', 'web', 'web_user');
        userMsg.metadata = { chatId: 'web-chat-1' };

        await agent.onMessage(userMsg);

        expect(tokens).toEqual(['Streamed ', 'Response']);
    });

    test('should NOT stream for whatsapp source', async () => {
        await agent.start();

        const tokens = [];
        mockInterface.on('agent:token', (data) => {
            tokens.push(data.content);
        });

        // Use 'whatsapp' source to trigger standard
        const userMsg = createUserMessage('Hello', 'whatsapp', 'wa_user');
        userMsg.metadata = { chatId: 'wa-chat-1' };

        await agent.onMessage(userMsg);

        expect(tokens).toEqual([]);
        const reply = mockInterface.getLastMessage();
        expect(reply.content).toBe('Fallback response'); // From standard sendMessage mock
    });
});
