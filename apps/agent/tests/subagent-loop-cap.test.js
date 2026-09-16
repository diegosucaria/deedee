const { Agent } = require('../src/agent');
const { createUserMessage } = require('@deedee/shared/src/types');

// Agent-level checks for sub-agent metadata: the per-run tool loop cap and
// the thought stream switch.
describe('sub-agent run limits in processMessage', () => {
    let agent;
    let notifications;

    const makeDb = () => ({
        getPendingGoals: jest.fn().mockReturnValue([]),
        getScheduledJobs: jest.fn().mockReturnValue([]),
        deleteJobState: jest.fn(),
        saveMessage: jest.fn(),
        logMetric: jest.fn(),
        logTokenUsage: jest.fn(),
        getHistoryForChat: jest.fn().mockReturnValue([]),
        getLatestSummary: jest.fn().mockReturnValue(null),
        getAllFacts: jest.fn().mockReturnValue([]),
        ensureSession: jest.fn(),
        countMessages: jest.fn().mockReturnValue(1),
        getFactsFormatted: jest.fn().mockReturnValue(''),
        getKey: jest.fn(),
        getAgentSetting: jest.fn().mockReturnValue(null),
        getSession: jest.fn().mockReturnValue({ id: 'chat-1', title: 'T' }),
        markStaleSubAgents: jest.fn().mockReturnValue(0),
        deleteMessagesFrom: jest.fn(),
        deleteMessagesSince: jest.fn(),
        createNotification: jest.fn(),
        close: jest.fn()
    });

    // Every model turn asks for one more tool call, so only the cap ends the loop.
    const functionCallChunk = () => ({ candidates: [{ content: { parts: [{ functionCall: { name: 'getWeather', args: {} } }] } }] });
    const alwaysCall = () => ({
        stream: (async function* () { yield functionCallChunk(); })(),
        response: Promise.resolve(functionCallChunk())
    });

    let create;

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        agent = new Agent({ interface: { send: jest.fn(), on: jest.fn(), broadcast: jest.fn().mockResolvedValue(true) }, googleApiKey: 'fake' });
        agent.db = makeDb();
        agent.smartContext.db = agent.db;
        agent.rateLimiter = { check: jest.fn().mockResolvedValue(true) };
        agent.commandHandler = { handle: jest.fn().mockResolvedValue(false) };
        agent._loadClientLibrary = jest.fn().mockResolvedValue({ GoogleGenAI: jest.fn().mockImplementation(() => ({})) });
        agent.mcp = { close: jest.fn().mockResolvedValue(), getTools: jest.fn().mockResolvedValue([]), cancelActiveCalls: jest.fn() };
        notifications = { create: jest.fn() };
        agent.notifications = notifications;
        agent.router = { route: jest.fn().mockResolvedValue({ model: 'FLASH', toolGroups: [] }) };
        create = jest.fn(() => ({
            sendMessageStream: jest.fn().mockImplementation(async () => alwaysCall()),
            sendMessage: jest.fn().mockImplementation(async () => functionCallChunk())
        }));
        agent.client = { chats: { create } };
        agent._executeTool = jest.fn().mockResolvedValue({ ok: true });
    });

    afterEach(async () => {
        if (agent) await agent.stop();
        jest.restoreAllMocks();
    });

    const msg = (source, metadata) => {
        const m = createUserMessage('weather?');
        m.source = source;
        m.timestamp = '2026-01-01T00:00:00.000Z';
        m.metadata = { chatId: 'chat-1', ...metadata };
        return m;
    };

    test('metadata.maxToolLoops caps a sub-agent run below the env default', async () => {
        const saved = process.env.MAX_TOOL_LOOPS;
        process.env.MAX_TOOL_LOOPS = '50';
        try {
            await agent.processMessage(msg('subagent', { isSubAgent: true, forceModel: 'FLASH', maxToolLoops: 2 }), jest.fn());
        } finally {
            if (saved === undefined) delete process.env.MAX_TOOL_LOOPS; else process.env.MAX_TOOL_LOOPS = saved;
        }
        expect(agent._executeTool).toHaveBeenCalledTimes(2);
        expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_loop_limit', title: expect.stringContaining('/2)') }));
    });

    test('sub-agent turns do not ask for thought parts; web turns do', async () => {
        await agent.processMessage(msg('subagent', { isSubAgent: true, forceModel: 'FLASH', maxToolLoops: 1 }), jest.fn());
        expect(create.mock.calls[0][0].config.thinkingConfig).toEqual({ includeThoughts: false });

        create.mockClear();
        agent._executeTool = jest.fn().mockResolvedValue({ ok: true });
        const saved = process.env.MAX_TOOL_LOOPS;
        process.env.MAX_TOOL_LOOPS = '1';
        try {
            await agent.processMessage(msg('web', {}), jest.fn());
        } finally {
            if (saved === undefined) delete process.env.MAX_TOOL_LOOPS; else process.env.MAX_TOOL_LOOPS = saved;
        }
        expect(create.mock.calls[0][0].config.thinkingConfig).toEqual({ includeThoughts: true });
    });
});
