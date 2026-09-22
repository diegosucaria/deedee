/**
 * The executors learn from the agent whether a turn is the owner's own chat
 * (context.ownerTyped). The wardrobe's photo tools take a photo from the chat
 * only then: a contact's photo must never enter his wardrobe.
 */
const { Agent } = require('../src/agent');

jest.mock('@google/genai');
jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({ GSuiteTools: jest.fn() }));
jest.mock('@deedee/mcp-servers/src/local/index', () => ({ LocalTools: jest.fn() }));
jest.mock('../src/db');
jest.mock('../src/router');
jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({ init: jest.fn(), getTools: jest.fn().mockResolvedValue([]), close: jest.fn().mockResolvedValue() }))
}));
jest.mock('../src/rate-limiter', () => ({ RateLimiter: jest.fn() }));
jest.mock('../src/confirmation-manager', () => ({ ConfirmationManager: jest.fn() }));

describe('the executor context says whose turn it is', () => {
    let agent, execute;

    beforeEach(() => {
        agent = new Agent({ interface: { send: jest.fn(), on: jest.fn() }, googleApiKey: 'test-key' });
        agent.db = {
            getPendingGoals: jest.fn().mockReturnValue([]), getScheduledJobs: jest.fn().mockReturnValue([]),
            saveMessage: jest.fn(), close: jest.fn(), getAllAgentSettings: jest.fn().mockReturnValue({}),
            markStaleSubAgents: jest.fn().mockReturnValue(0),
            db: { prepare: jest.fn().mockReturnValue({ get: jest.fn(), all: jest.fn().mockReturnValue([]), run: jest.fn() }) },
        };
        execute = jest.fn().mockResolvedValue('ok');
        agent.toolExecutor.execute = execute;
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        if (agent.stop) await agent.stop();
    });

    const contextOf = () => execute.mock.calls[0][2];

    test('behind his login (the web) the turn is his', async () => {
        await agent._executeTool('search_garments', { query: 'blue shirt' }, { role: 'user', content: 'x', source: 'web', metadata: { chatId: 'web-1' } });
        expect(contextOf().ownerTyped).toBe(true);
    });

    test("the mirror of his personal WhatsApp carries his contacts' messages: never his", async () => {
        await agent._executeTool('search_garments', { query: 'blue shirt' }, { role: 'user', content: 'x', source: 'whatsapp:user', metadata: { chatId: '15550100@s.whatsapp.net' } });
        expect(contextOf().ownerTyped).toBe(false);
    });

    test('his own WhatsApp chat with the assistant is his; a contact\'s chat there is not', async () => {
        // The real approval service stays (the gate runs before the executor); only the owner check is scripted.
        jest.spyOn(agent.approvals, '_isOwnerChat').mockImplementation(async (m) => m.metadata.chatId === '15550100@s.whatsapp.net');
        await agent._executeTool('search_garments', { query: 'x' }, { role: 'user', content: 'x', source: 'whatsapp', metadata: { chatId: '15550100@s.whatsapp.net' } });
        expect(contextOf().ownerTyped).toBe(true);
        execute.mockClear();
        await agent._executeTool('search_garments', { query: 'x' }, { role: 'user', content: 'x', source: 'whatsapp', metadata: { chatId: '15550199@s.whatsapp.net' } });
        expect(contextOf().ownerTyped).toBe(false);
    });

    test('a group, a sub-agent and a job are never his', async () => {
        for (const message of [
            { role: 'user', content: 'x', source: 'web', metadata: { chatId: 'g', isGroup: true } },
            { role: 'user', content: 'x', source: 'web', metadata: { chatId: 'subagent-1', isSubAgent: true } },
            { role: 'user', content: 'x', source: 'scheduler', metadata: { chatId: 'system_job_1' } },
        ]) {
            execute.mockClear();
            await agent._executeTool('search_garments', { query: 'x' }, message);
            expect(contextOf().ownerTyped).toBe(false);
        }
    });
});
