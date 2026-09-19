/**
 * A turn answered by an external model (xAI Grok) carries no tools. It used
 * to get the whole chat prompt, about 12,000 characters of rules for tools
 * it cannot call, and the prompt sat on the agent where two turns could swap.
 */
const { getGrokSystemInstruction, factsWithoutLookups } = require('../src/prompts/grok');
const { getSystemInstruction } = require('../src/prompts/system');
const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

jest.mock('axios');
jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({ init: jest.fn(), getTools: jest.fn().mockResolvedValue([]), close: jest.fn() }))
}));

const FACTS = `USER PROFILE (durable facts about the owner):
- home_city: "Springfield"
AGENT NOTES (what you learned about doing the job):
- prefers_short: "yes"
ALSO STORED, names only (2). Their values are kept in full; getFact(key) reads one:
car_plate, shoe_size
(3 more facts are stored and not listed. getFact(key) reads any fact by name; searchMemory(query) finds one by words. Use them before saying you do not know.)`;

describe('getGrokSystemInstruction', () => {
    const prompt = getGrokSystemInstruction({ dateString: 'NOW', facts: FACTS, communicationStyle: 'dry and brief', ownerName: 'Sam', skillsContext: 'SKILL-MARKER', vaultContext: 'VAULT-MARKER' });

    test('keeps who it is, the constitution, the language rule, the style and what it knows', () => {
        for (const part of ['You are Deedee', 'Your owner is "Sam"', 'CONSTITUTION:', 'Privacy First', 'CURRENT_TIME: NOW', 'LANGUAGE PROTOCOL', 'Strict Matching', 'dry and brief', 'home_city: "Springfield"', 'prefers_short', 'SKILL-MARKER', 'VAULT-MARKER']) {
            expect(prompt).toContain(part);
        }
    });

    test('names no tool it cannot call, and says plainly that none can run', () => {
        expect(prompt).toContain('NO TOOLS IN THIS MODE');
        expect(prompt).toContain('Never say you did something you could not do.');
        for (const tool of ['replyWithAudio', 'scheduleJob', 'setReminder', 'lookupDevice', 'browser_', 'commitAndPush', 'getFact', 'searchMemory', 'googleSearch', 'saveNoteToVault', 'ALSO STORED', 'car_plate']) {
            expect(prompt).not.toContain(tool);
        }
    });

    test('is a fraction of the chat prompt, and has no leftover indentation', () => {
        const full = getSystemInstruction('NOW', '', FACTS, { codingMode: true, communicationStyle: 'dry and brief' });
        expect(prompt.length).toBeLessThan(full.length / 3);
        expect(prompt).not.toMatch(/^ {8,}\S/m);
    });

    test('with nothing to add it is still a whole prompt', () => {
        const bare = getGrokSystemInstruction();
        expect(bare).toContain('You are Deedee');
        expect(bare).toContain('NO TOOLS IN THIS MODE');
        expect(bare).not.toContain('WHAT I KNOW');
        expect(bare).not.toContain('undefined');
    });

    test('factsWithoutLookups keeps the value lines only', () => {
        expect(factsWithoutLookups(FACTS).split('\n')).toHaveLength(4);
        expect(factsWithoutLookups('- a: 1')).toBe('- a: 1');
        expect(factsWithoutLookups(null)).toBe('');
    });
});

describe('a Grok turn through the agent', () => {
    const dbPath = path.join(__dirname, 'test_grok_prompt.db');
    let agent, spies, create;

    const streamOf = (text) => ({ async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: text } }] }; } });

    beforeEach(() => {
        fs.rmSync(dbPath, { recursive: true, force: true });
        agent = new Agent({ googleApiKey: 'test_key', interface: { on: jest.fn(), emit: jest.fn(), send: jest.fn().mockResolvedValue(true) } });
        agent.db = new AgentDB(dbPath);
        agent.db.init();
        agent.router.route = jest.fn().mockResolvedValue({ model: 'FLASH', toolMode: 'STANDARD', toolGroups: [] });
        agent.client = { models: { generateContent: jest.fn() }, chats: { create: jest.fn() } };
        create = jest.fn().mockImplementation(async () => streamOf('hello'));
        agent.xaiClient = { chat: { completions: { create } } };
        spies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        spies.forEach(s => s.mockRestore());
        agent.db.close();
        fs.rmSync(dbPath, { recursive: true, force: true });
    });

    test('sends the tool-free prompt, and no empty rows from tool calls in the history', async () => {
        agent.db.saveMessage({ id: 'h1', role: 'user', content: 'turn on the light', chatId: 'web-1', source: 'web' });
        agent.db.saveMessage({ id: 'h2', role: 'model', parts: [{ functionCall: { name: 'ha_call_service', args: {} } }], chatId: 'web-1', source: 'web' });
        agent.db.saveMessage({ id: 'h3', role: 'model', content: 'done', chatId: 'web-1', source: 'web' });
        await agent.processMessage({ role: 'user', source: 'web', content: 'what is the capital of France', metadata: { chatId: 'web-1', model: 'grok-4', replyMode: 'text' } }, jest.fn());

        const sent = create.mock.calls[0][0];
        expect(sent.model).toBe('grok-4');
        expect(sent.tools).toBeUndefined();
        expect(sent.messages[0].role).toBe('system');
        expect(sent.messages[0].content).toContain('NO TOOLS IN THIS MODE');
        expect(sent.messages[0].content).not.toContain('AVAILABLE TOOLS');
        expect(sent.messages[0].content).not.toContain('replyWithAudio');
        expect(sent.messages.every(m => typeof m.content === 'string' && m.content.trim().length > 0)).toBe(true);
        expect(agent.client.chats.create).not.toHaveBeenCalled();
    });

    test('the prompt belongs to the turn, not to the agent', async () => {
        await agent._generateStreamGrok(agent.xaiClient, 'grok-4', 'hi', [], 'c1', 't1', 'PROMPT-ONE');
        await agent._generateStreamGrok(agent.xaiClient, 'grok-4', 'hi', [], 'c2', 't2', 'PROMPT-TWO');
        expect(create.mock.calls.map(c => c[0].messages[0].content)).toEqual(['PROMPT-ONE', 'PROMPT-TWO']);
        expect(agent.currentSystemPrompt).toBeUndefined();
    });
});
