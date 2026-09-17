/**
 * Usage attribution on the main chat path: token_usage rows carry a tag per
 * call class, the prompt estimate columns, and a prefix_hash metric per turn.
 */
const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

jest.mock('axios');

const mockMcpTools = [
    { name: 'ha_call_service', description: 'Call a service', parameters: { type: 'object', properties: {} }, serverName: 'homeassistant' }
];

jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({
        init: jest.fn(),
        getTools: jest.fn().mockResolvedValue(mockMcpTools),
        close: jest.fn()
    }))
}));

const usage = { promptTokenCount: 1200, candidatesTokenCount: 30, totalTokenCount: 1230, cachedContentTokenCount: 0, thoughtsTokenCount: 0 };
const textReply = { candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: usage };
const toolReply = { candidates: [{ content: { parts: [{ functionCall: { name: 'getFact', args: { key: 'colour' } } }] } }], usageMetadata: usage };

const asStream = (reply) => ({
    stream: (async function* () { yield { ...reply, text: () => reply.candidates[0].content.parts[0].text || '' }; })(),
    response: Promise.resolve(reply)
});

describe('Agent usage attribution', () => {
    const dbPath = path.join(__dirname, 'test_usage_attribution.db');
    let agent;
    let session;

    beforeEach(() => {
        fs.rmSync(dbPath, { recursive: true, force: true });
        agent = new Agent({ googleApiKey: 'test_key', interface: { on: jest.fn(), emit: jest.fn(), send: jest.fn() } });
        agent.db = new AgentDB(dbPath);
        agent.db.init();
        session = {
            sendMessage: jest.fn().mockResolvedValue({ response: textReply }),
            sendMessageStream: jest.fn().mockImplementation(async () => asStream(textReply))
        };
        agent.client = { models: { generateContent: jest.fn() }, chats: { create: jest.fn().mockReturnValue(session) } };
        agent.smartContext.getContext = jest.fn().mockResolvedValue([]);
    });

    afterEach(() => {
        agent.db.close();
        fs.rmSync(dbPath, { recursive: true, force: true });
    });

    const rows = (chatId) => agent.db.db.prepare('SELECT tag, prompt_tokens, sys_tokens_est, tools_tokens_est, history_tokens_est, decl_count FROM token_usage WHERE chat_id = ? ORDER BY id').all(chatId);
    const hashMetrics = (chatId) => agent.db.db.prepare("SELECT value, metadata FROM metrics WHERE type = 'prefix_hash' ORDER BY id").all()
        .map(r => ({ value: r.value, ...JSON.parse(r.metadata) })).filter(m => m.chatId === chatId);

    const run = async (chatId, { source = 'web', metadata = {}, content = 'hello', decision = { model: 'FLASH', toolMode: 'STANDARD', toolGroups: [] } } = {}) => {
        agent.router.route = jest.fn().mockResolvedValue(decision);
        await agent.processMessage({ content, role: 'user', source, metadata: { chatId, replyMode: 'text', ...metadata } }, jest.fn());
    };

    test('an interactive turn logs tag chat', async () => {
        await run('c-chat');
        expect(rows('c-chat').map(r => r.tag)).toEqual(['chat']);
    });

    test('a scheduler run logs tag job', async () => {
        await run('c-job', { source: 'scheduler', metadata: { jobName: 'nightly' } });
        expect(rows('c-job').map(r => r.tag)).toEqual(['job']);
    });

    test('a sub-agent run logs tag subagent', async () => {
        await run('c-sub', { source: 'subagent', metadata: { isSubAgent: true, allowedTools: ['getFact'] } });
        expect(rows('c-sub').map(r => r.tag)).toEqual(['subagent']);
    });

    test('a watcher alert logs tag watcher', async () => {
        await run('c-watch', { source: 'system', content: 'SYSTEM_WATCHER_ALERT: something matched.' });
        expect(rows('c-watch').map(r => r.tag)).toEqual(['watcher']);
    });

    test('tool-loop rows get the _tool_loop suffix and keep the estimates', async () => {
        session.sendMessageStream
            .mockImplementationOnce(async () => asStream(toolReply))
            .mockImplementationOnce(async () => asStream(textReply));
        await run('c-loop');
        const r = rows('c-loop');
        expect(r.map(x => x.tag)).toEqual(['chat', 'chat_tool_loop']);
        expect(r[1].sys_tokens_est).toBe(r[0].sys_tokens_est);
        expect(r[1].decl_count).toBe(r[0].decl_count);
    });

    test('estimate columns are persisted and match the request sent', async () => {
        await run('c-est');
        const [r] = rows('c-est');
        const cfg = agent.client.chats.create.mock.calls[0][0].config;
        const decls = cfg.tools[0].functionDeclarations;
        expect(r.prompt_tokens).toBe(1200);
        expect(r.sys_tokens_est).toBe(Math.ceil(cfg.systemInstruction.length / 4));
        expect(r.tools_tokens_est).toBe(Math.ceil(JSON.stringify(decls).length / 4));
        expect(r.decl_count).toBe(decls.length);
        expect(r.history_tokens_est).toBe(Math.ceil('[]'.length / 4));
        expect(r.sys_tokens_est).toBeGreaterThan(100);
        expect(r.decl_count).toBeGreaterThan(5);
    });

    test('rows written by other call sites keep NULL estimates', () => {
        agent.db.logTokenUsage({ model: 'm', promptTokens: 1, candidateTokens: 1, totalTokens: 2, chatId: 'c-null', estimatedCost: 0, tag: 'title' });
        const [r] = rows('c-null');
        expect(r).toEqual({ tag: 'title', prompt_tokens: 1, sys_tokens_est: null, tools_tokens_est: null, history_tokens_est: null, decl_count: null });
    });

    test('prefix hash is stable across two identical turns and changes with the tool set', async () => {
        const logs = jest.spyOn(console, 'log').mockImplementation(() => { });
        try {
            await run('c-hash');
            await run('c-hash');
            let m = hashMetrics('c-hash');
            expect(m.map(x => x.value)).toEqual([0, 0]);
            expect(m[1].hash).toBe(m[0].hash);
            expect(m[1].prev).toBe(m[0].hash);
            expect(logs.mock.calls.some(c => String(c[0]).includes('Prefix hash changed'))).toBe(false);

            await run('c-hash', { decision: { model: 'FLASH', toolMode: 'STANDARD', toolGroups: ['home'] } });
            m = hashMetrics('c-hash');
            expect(m.map(x => x.value)).toEqual([0, 0, 1]);
            expect(m[2].hash).not.toBe(m[1].hash);
            expect(m[2].declCount).toBeGreaterThan(m[1].declCount);
            const changeLines = logs.mock.calls.filter(c => String(c[0]).includes('Prefix hash changed'));
            expect(changeLines).toHaveLength(1);
            expect(changeLines[0][0]).toContain('c-hash');
        } finally {
            logs.mockRestore();
        }
    });

    test('the prefix hash map is per chat', async () => {
        await run('c-a');
        await run('c-b', { decision: { model: 'FLASH', toolMode: 'STANDARD', toolGroups: ['home'] } });
        expect(hashMetrics('c-a').map(x => x.value)).toEqual([0]);
        expect(hashMetrics('c-b').map(x => x.value)).toEqual([0]);
    });
});
