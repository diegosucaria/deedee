const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

jest.mock('axios');

const mockMcpTools = [
    { name: 'ha_call_service', description: 'Call a service', parameters: { type: 'object', properties: {} }, serverName: 'homeassistant' },
    { name: 'work_gmail', description: 'Gmail', parameters: { type: 'object', properties: {} }, serverName: 'gws_work' }
];

jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getTools: jest.fn().mockResolvedValue(mockMcpTools),
        close: jest.fn()
    }))
}));

describe('Agent request context and tool scoping', () => {
    const dbPath = path.join(__dirname, 'test_context_tokens.db');
    let agent;
    let session;

    const reply = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };

    beforeEach(() => {
        fs.rmSync(dbPath, { recursive: true, force: true });
        agent = new Agent({ googleApiKey: 'test_key', interface: { on: jest.fn(), emit: jest.fn(), send: jest.fn() } });
        agent.db = new AgentDB(dbPath);
        agent.db.init();
        session = {
            sendMessage: jest.fn().mockResolvedValue({ response: reply }),
            sendMessageStream: jest.fn().mockResolvedValue({
                stream: (async function* () { yield { text: () => 'ok' }; })(),
                response: Promise.resolve(reply)
            })
        };
        agent.client = { models: { generateContent: jest.fn() }, chats: { create: jest.fn().mockReturnValue(session) } };
        agent.smartContext.getContext = jest.fn().mockResolvedValue([]);
    });

    afterEach(() => {
        agent.db.close();
        fs.rmSync(dbPath, { recursive: true, force: true });
    });

    const run = async (decision, metadata = {}, content = 'hello') => {
        agent.router.route = jest.fn().mockResolvedValue(decision);
        await agent.processMessage({ content, role: 'user', source: 'web', metadata: { chatId: 'ctx-test', replyMode: 'text', ...metadata } }, jest.fn());
        const cfg = agent.client.chats.create.mock.calls[0][0].config;
        return { cfg, names: cfg.tools[0].functionDeclarations.map(d => d.name), decls: cfg.tools[0].functionDeclarations };
    };

    test('core-only turn drops group tools and strips scoping fields', async () => {
        const { names, decls } = await run({ model: 'FLASH', toolMode: 'STANDARD', toolGroups: [] });
        expect(names).toContain('rememberFact');
        expect(names).not.toContain('ha_call_service');
        expect(names).not.toContain('work_gmail');
        expect(names).not.toContain('lookupDevice');
        expect(decls.some(d => 'serverName' in d || 'category' in d)).toBe(false);
    });

    test('a named group brings its MCP server back', async () => {
        const { names } = await run({ model: 'FLASH', toolMode: 'STANDARD', toolGroups: ['home'] });
        expect(names).toContain('ha_call_service');
        expect(names).toContain('lookupDevice');
        expect(names).not.toContain('work_gmail');
    });

    test('no toolGroups (router fallback) keeps every tool', async () => {
        const { names } = await run({ model: 'PRO', toolMode: 'STANDARD' });
        expect(names).toEqual(expect.arrayContaining(['ha_call_service', 'work_gmail', 'lookupDevice']));
    });

    test('server: allow-list entries match MCP tools by server name', async () => {
        const { names } = await run({ model: 'FLASH', toolMode: 'STANDARD' }, { isSubAgent: true, allowedTools: ['server:gws_work'] });
        expect(names).toContain('work_gmail');
        expect(names).not.toContain('ha_call_service');
    });

    test('watcher-triggered runs keep every tool even when the router names none', async () => {
        const { names } = await run({ model: 'FLASH', toolMode: 'STANDARD', toolGroups: [] }, {}, 'SYSTEM_WATCHER_ALERT: A message matched watcher conditions.');
        expect(names).toEqual(expect.arrayContaining(['ha_call_service', 'work_gmail', 'lookupDevice']));
    });

    test('per-turn context rides in the user turn, not the system instruction', async () => {
        const { cfg } = await run({ model: 'FLASH', toolMode: 'STANDARD', toolGroups: [] });
        const year = String(new Date().getFullYear());
        expect(cfg.systemInstruction).toContain('given in the TURN CONTEXT block');
        const sent = session.sendMessageStream.mock.calls[0][0].message;
        expect(sent.parts[0].text.startsWith('[TURN CONTEXT')).toBe(true);
        expect(sent.parts[0].text).toContain(year);
        expect(sent.parts[1].text).toBe('hello');
    });
});
