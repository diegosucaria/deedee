
const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');
const { createUserMessage } = require('@deedee/shared/src/types');

// Mock Dependencies
jest.mock('../src/db', () => ({
    AgentDB: jest.fn().mockImplementation(() => ({
        db: { prepare: jest.fn().mockReturnValue({ all: jest.fn().mockReturnValue([]) }) },
        saveMessage: jest.fn(), countMessages: jest.fn().mockReturnValue(0), ensureSession: jest.fn(),
        checkLimit: jest.fn().mockReturnValue(0), logMetric: jest.fn(), getAllAgentSettings: jest.fn().mockReturnValue({}), logTokenUsage: jest.fn(),
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
        deleteMessagesFrom: jest.fn(),
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
                // Verify payload wrapper
                if (!payload.message) throw new Error('SDK Requirement: Payload must be wrapped in { message: ... }');

                const content = payload.message;

                // Enforce STRICT ContentUnion validation (Safety Check)
                // The Fix ensures we always send { role, parts: [...] }
                const isString = typeof content === 'string';
                const hasParts = content.parts && Array.isArray(content.parts);

                if (isString) {
                    // This is what caused the crash in production (depending on SDK version)
                    // We WANT to prevent this now.
                    // throw new Error('Regression: Agent sent raw string. Mismatched SDK expectation.');
                }

                if (!isString && !hasParts) {
                    // Empty object or invalid structure
                    throw new Error('ContentUnion is required (Mock Rejection)');
                }

                const streamGenerator = async function* () {
                    yield {
                        text: () => { throw new Error('No text'); },
                        candidates: [{ content: { parts: [{ text: 'Streamed ' }] } }]
                    };
                    yield {
                        text: () => { throw new Error('No text'); },
                        candidates: [{ content: { parts: [{ text: 'Response' }] } }]
                    };
                };

                return streamGenerator();
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
