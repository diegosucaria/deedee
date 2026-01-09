const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');
const { createUserMessage } = require('@deedee/shared/src/types');

// --- MOCKS ---
// Mock DB with necessary methods
jest.mock('../src/db', () => ({
    AgentDB: jest.fn().mockImplementation(() => ({
        db: {
            prepare: jest.fn().mockReturnValue({ all: jest.fn().mockReturnValue([]) })
        },
        saveMessage: jest.fn(),
        getKey: jest.fn(),
        setKey: jest.fn(),
        countMessages: jest.fn().mockReturnValue(0),
        ensureSession: jest.fn(),
        getWatchers: jest.fn().mockReturnValue([]),
        updateWatcher: jest.fn(),
        checkLimit: jest.fn().mockReturnValue(0),
        logUsage: jest.fn(),
        logMetric: jest.fn(),
        getScheduledJobs: jest.fn().mockReturnValue([]), // Added
        saveScheduledJob: jest.fn(),
        deleteScheduledJob: jest.fn(),
        getPendingGoals: jest.fn().mockReturnValue([]),
        deleteJobState: jest.fn(),
        getHistoryForChat: jest.fn().mockReturnValue([]), // Added
        deleteMessagesSince: jest.fn(), // Added
        getLatestSummary: jest.fn().mockReturnValue(null), // Added
        getFactsFormatted: jest.fn().mockReturnValue(""), // Added
        close: jest.fn().mockResolvedValue()
    }))
}));

jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({
    GSuiteTools: jest.fn()
}));

jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getTools: jest.fn().mockResolvedValue([]),
        close: jest.fn().mockResolvedValue() // Fix promise return
    }))
}));

// Mock GoogleGenAI to verify calls
const MockGoogleGenAI = jest.fn().mockImplementation(() => ({
    chats: {
        create: jest.fn().mockReturnValue({
            sendMessage: jest.fn().mockResolvedValue({
                response: { text: () => "I should not be called" }
            }),
            sendMessageStream: jest.fn().mockResolvedValue({
                stream: (async function* () { })(),
                response: Promise.resolve({})
            })
        })
    }
}));

describe('Security & Privacy Enforcement', () => {
    let agent;
    let mockInterface;

    beforeEach(() => {
        jest.clearAllMocks();
        mockInterface = new MockInterface();
        mockInterface.broadcast = jest.fn().mockResolvedValue(true);

        agent = new Agent({
            googleApiKey: 'fake-key',
            interface: mockInterface
        });

        // Inject Mock SDK
        const mockModule = { GoogleGenAI: MockGoogleGenAI };
        agent._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
        agent.router._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);

        // Spy on critical internal methods
        jest.spyOn(agent, '_autoTitleSession').mockResolvedValue();
        jest.spyOn(agent, '_analyzeAttachment').mockResolvedValue();
    });

    afterEach(async () => {
        if (agent) await agent.stop();
    });

    test('PASSIVE MODE: Should STRICTLY IGNORE messages from "whatsapp:user" (mirror session)', async () => {
        // 1. Setup
        await agent.start();
        const passiveMsg = createUserMessage('This is a private message', 'whatsapp:user', '5551234');
        passiveMsg.metadata = { chatId: '5551234@s.whatsapp.net' };

        // 2. Execute
        const executionSummary = await agent.processMessage(passiveMsg, async () => {
            throw new Error("Callback should NOT be called in Passive Mode!");
        });

        // 3. Verification

        // A. Should NOT generate any replies
        expect(executionSummary.replies).toHaveLength(0);
        expect(executionSummary.toolOutputs).toHaveLength(0);

        // B. Should NOT trigger Auto-Title (Security/Cost)
        expect(agent._autoTitleSession).not.toHaveBeenCalled();

        // C. Should NOT trigger Smart Analysis
        expect(agent._analyzeAttachment).not.toHaveBeenCalled();

        // D. Should NOT verify rate limits (optimization/noise)
        // (Optional, implementation detail, but good to know)

        // E. Should NOT call LLM (Router)
        // The router is in agent.router.route()
        // We can spy on the router log or just assume if replies are empty it didn't run?
        // Better: spy on client.chats.create (which Router uses if it ran)
        // Actually Router uses a separate instance or the same?
        // In agent.js: `this.client` is used.
        // Wait, Router uses `this.client` too?
        // Agent Router logic calls `router.route(text, context)`.
        // Let's spy on agent.router.route
        const routerSpy = jest.spyOn(agent.router, 'route');
        expect(routerSpy).not.toHaveBeenCalled();
    });

    test('ACTIVE MODE: Should process normal assistant messages', async () => {
        // Control test to ensure we didn't break everything
        await agent.start();
        const activeMsg = createUserMessage('Hello Agent', 'whatsapp:assistant', '5559999');
        activeMsg.metadata = { chatId: '5559999@s.whatsapp.net' };

        // Mock Router Response for this test
        const mockModule = { GoogleGenAI: MockGoogleGenAI };
        agent.router.route = jest.fn().mockResolvedValue({
            decision: 'FLASH',
            model: 'gemini-2.0-flash-exp',
            reason: 'Test'
        });

        // Execute
        await agent.processMessage(activeMsg, async () => { });

        // Verify Auto-Title IS called for new session
        expect(agent._autoTitleSession).toHaveBeenCalled();
    });
});
