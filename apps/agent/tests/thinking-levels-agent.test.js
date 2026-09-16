const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

jest.mock('axios');

jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getTools: jest.fn().mockResolvedValue([]),
        close: jest.fn()
    }))
}));

describe('Agent thinking config per call class and source', () => {
    const dbPath = path.join(__dirname, 'test_thinking_levels.db');
    let agent;
    let session;

    const reply = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
    const ENV = ['THINKING_PRO', 'THINKING_PRO_CHAT', 'THINKING_PRO_TOOL_LOOP', 'THINKING_FLASH'];
    let saved;

    beforeEach(() => {
        saved = {};
        for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
        fs.rmSync(dbPath, { recursive: true, force: true });
        agent = new Agent({ googleApiKey: 'test_key', interface: { on: jest.fn(), emit: jest.fn(), send: jest.fn(), broadcast: jest.fn().mockResolvedValue(true) } });
        agent.db = new AgentDB(dbPath);
        agent.db.init();
        session = {
            sendMessage: jest.fn().mockResolvedValue({ response: reply, ...reply }),
            sendMessageStream: jest.fn().mockResolvedValue({
                stream: (async function* () { yield { text: () => 'ok', candidates: reply.candidates }; })(),
                response: Promise.resolve(reply)
            })
        };
        agent.client = { models: { generateContent: jest.fn() }, chats: { create: jest.fn().mockReturnValue(session) } };
        agent.smartContext.getContext = jest.fn().mockResolvedValue([]);
    });

    afterEach(() => {
        agent.db.close();
        fs.rmSync(dbPath, { recursive: true, force: true });
        for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    });

    const run = async (source, decision = { model: 'PRO', toolMode: 'STANDARD', toolGroups: [] }, metadata = {}) => {
        agent.router.route = jest.fn().mockResolvedValue(decision);
        await agent.processMessage({ content: 'hello', role: 'user', source, metadata: { chatId: `thk-${source}`, replyMode: 'text', ...metadata } }, jest.fn());
        return agent.client.chats.create.mock.calls[0][0].config;
    };

    test('web keeps thought summaries and gets the chat level', async () => {
        const cfg = await run('web');
        expect(cfg.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true });
        expect(cfg.thinkingConfig.thinkingBudget).toBeUndefined();
    });

    test('WhatsApp gets the level but no thought summaries', async () => {
        const cfg = await run('whatsapp');
        expect(cfg.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    });

    test('scheduler runs are jobs: PRO at MEDIUM, no thoughts', async () => {
        const cfg = await run('scheduler');
        expect(cfg.thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM' });
    });

    test('sub-agents get the subagent level and no thoughts', async () => {
        const cfg = await run('subagent', { model: 'FLASH', toolMode: 'STANDARD', toolGroups: [] }, { isSubAgent: true, taskId: 't1' });
        expect(cfg.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    });

    test('a non-3.x Pro id gets no thinkingLevel', async () => {
        const real = agent.configService.getModel.bind(agent.configService);
        agent.configService.getModel = (role) => (role === 'PRO' ? 'gemini-2.5-pro' : real(role));
        const cfg = await run('whatsapp');
        expect(agent.client.chats.create.mock.calls[0][0].model).toBe('gemini-2.5-pro');
        expect(cfg.thinkingConfig).toBeUndefined();
    });

    test('THINKING_PRO_CHAT env override reaches the session', async () => {
        process.env.THINKING_PRO_CHAT = 'HIGH';
        const cfg = await run('web');
        expect(cfg.thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true });
    });

    test('the first turn is sent without a per-call config', async () => {
        await run('web');
        expect(session.sendMessageStream.mock.calls[0][0].config).toBeUndefined();
    });

    describe('tool loop', () => {
        const functionCallChunk = { candidates: [{ content: { parts: [{ functionCall: { name: 'getWeather', args: {} } }] } }] };
        const textChunk = { candidates: [{ content: { parts: [{ text: 'done' }] } }] };
        const streamOf = (chunk) => ({ stream: (async function* () { yield chunk; })(), response: Promise.resolve(chunk) });

        const runLoop = async () => {
            session.sendMessageStream
                .mockImplementationOnce(async () => streamOf(functionCallChunk))
                .mockImplementationOnce(async () => streamOf(textChunk));
            agent._executeTool = jest.fn().mockResolvedValue({ ok: true });
            await run('web');
            expect(agent._executeTool).toHaveBeenCalledTimes(1);
            expect(session.sendMessageStream).toHaveBeenCalledTimes(2);
            return session.sendMessageStream.mock.calls[1][0].config;
        };

        test('an unchanged loop level sends no per-call config', async () => {
            expect(await runLoop()).toBeUndefined();
        });

        test('THINKING_PRO_TOOL_LOOP re-sends the full session config with the loop level', async () => {
            process.env.THINKING_PRO_TOOL_LOOP = 'MEDIUM';
            const cfg = await runLoop();
            const sessionCfg = agent.client.chats.create.mock.calls[0][0].config;
            expect(sessionCfg.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true });
            expect(cfg.thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM', includeThoughts: true });
            expect(cfg.tools).toBe(sessionCfg.tools);
            expect(cfg.systemInstruction).toBe(sessionCfg.systemInstruction);
        });
    });
});
