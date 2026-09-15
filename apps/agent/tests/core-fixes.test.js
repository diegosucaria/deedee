const { Agent } = require('../src/agent');
const { createUserMessage } = require('@deedee/shared/src/types');

// Agent-level checks for the delivery, rewind, rate-limit and abort fixes.
describe('Agent core fixes', () => {
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
    });

    afterEach(async () => {
        if (agent) await agent.stop();
        jest.restoreAllMocks();
    });

    const userMsg = (content, extra = {}) => {
        const msg = createUserMessage(content);
        msg.source = extra.source || 'web';
        msg.timestamp = extra.timestamp || '2026-01-01T00:00:00.000Z';
        msg.metadata = { chatId: 'chat-1', ...(extra.metadata || {}) };
        return msg;
    };

    describe('_deliverReply', () => {
        test('records a delivery_failure notification when the callback returns false', async () => {
            const cb = jest.fn().mockResolvedValue(false);
            const reply = { content: 'x'.repeat(300), source: 'whatsapp', metadata: { chatId: 'chat-1' } };
            const result = await agent._deliverReply(cb, reply, userMsg('hi'));
            expect(result).toBe(false);
            expect(notifications.create).toHaveBeenCalledTimes(1);
            const n = notifications.create.mock.calls[0][0];
            expect(n.type).toBe('delivery_failure');
            expect(n.title).toBe('Reply not delivered');
            expect(n.metadata.chatId).toBe('chat-1');
            expect(n.metadata.source).toBe('whatsapp');
            expect(n.metadata.content).toHaveLength(200);
        });

        test('stays quiet when the callback returns undefined or true', async () => {
            await agent._deliverReply(jest.fn().mockResolvedValue(undefined), { content: 'a' }, userMsg('hi'));
            await agent._deliverReply(jest.fn().mockResolvedValue(true), { content: 'b' }, userMsg('hi'));
            expect(notifications.create).not.toHaveBeenCalled();
        });
    });

    describe('error path', () => {
        test('rewinds with deleteMessagesSince and reports an undelivered error reply', async () => {
            agent.router = { route: jest.fn().mockRejectedValue(new Error('boom')) };
            const sendCallback = jest.fn().mockResolvedValue(false);
            const msg = userMsg('hello');

            await agent.processMessage(msg, sendCallback);

            expect(agent.db.deleteMessagesSince).toHaveBeenCalledWith('chat-1', msg.timestamp);
            expect(agent.db.deleteMessagesFrom).not.toHaveBeenCalled();
            expect(sendCallback).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('boom') }));
            expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'delivery_failure' }));
        });
    });

    describe('rate limiter gate', () => {
        beforeEach(() => {
            // Stop right after the rate-limit step.
            agent.router = { route: jest.fn().mockRejectedValue(new Error('stop here')) };
        });

        test.each(['scheduler', 'subagent', 'system'])('does not consult the limiter for source %s', async (source) => {
            await agent.processMessage(userMsg('run', { source }), jest.fn());
            expect(agent.rateLimiter.check).not.toHaveBeenCalled();
        });

        test('does not consult the limiter for sub-agent metadata', async () => {
            await agent.processMessage(userMsg('run', { metadata: { isSubAgent: true, taskId: 't1' } }), jest.fn());
            expect(agent.rateLimiter.check).not.toHaveBeenCalled();
        });

        test('does not consult the limiter for watcher runs', async () => {
            await agent.processMessage(userMsg('SYSTEM_WATCHER_ALERT: something', { source: 'web' }), jest.fn());
            expect(agent.rateLimiter.check).not.toHaveBeenCalled();
        });

        test.each(['web', 'telegram', 'ios'])('consults the limiter for source %s', async (source) => {
            await agent.processMessage(userMsg('hi', { source }), jest.fn());
            expect(agent.rateLimiter.check).toHaveBeenCalledTimes(1);
        });

        test('blocks and notifies when the limiter says no', async () => {
            agent.rateLimiter.check.mockResolvedValue(false);
            const result = await agent.processMessage(userMsg('hi'), jest.fn());
            expect(result.replies).toHaveLength(0);
            expect(agent.router.route).not.toHaveBeenCalled();
            expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'rate_limit_exceeded' }));
        });
    });

    describe('abortChat', () => {
        // Web sources stream: the function call must arrive in a chunk.
        const functionCallResponse = () => {
            const chunk = { candidates: [{ content: { parts: [{ functionCall: { name: 'getWeather', args: {} } }] } }] };
            return {
                stream: (async function* () { yield chunk; })(),
                response: Promise.resolve(chunk)
            };
        };

        test('leaves the tool loop once the chat is aborted', async () => {
            agent.router = { route: jest.fn().mockResolvedValue({ model: 'FLASH', toolGroups: [] }) };
            const sendMessageStream = jest.fn().mockImplementation(async () => functionCallResponse());
            agent.client = { chats: { create: () => ({ sendMessageStream, sendMessage: jest.fn() }) } };
            agent._executeTool = jest.fn().mockImplementation(async () => {
                agent.abortChat('chat-1');
                return { ok: true };
            });

            const sendCallback = jest.fn();
            await agent.processMessage(userMsg('weather?'), sendCallback);

            expect(agent._executeTool).toHaveBeenCalledTimes(1);
            expect(sendMessageStream.mock.calls.length).toBeLessThanOrEqual(3);
            expect(sendCallback).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/^Stopped:/) }));
            // The flag is cleared once the run ends.
            expect(agent._abortedChats.has('chat-1')).toBe(false);
        });

        test('clears the flag when a run for that chat ends', async () => {
            agent.abortChat('chat-1');
            agent.router = { route: jest.fn().mockRejectedValue(new Error('stop here')) };
            await agent.processMessage(userMsg('hi'), jest.fn());
            expect(agent._abortedChats.has('chat-1')).toBe(false);
        });

        test('ignores empty ids', () => {
            agent.abortChat(undefined);
            agent.abortChat('');
            expect(agent._abortedChats.size).toBe(0);
        });
    });
});
