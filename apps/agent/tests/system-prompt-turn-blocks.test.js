/**
 * The text agent.js adds to the system instruction for one turn.
 */
const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

jest.mock('axios');

let mockMcpTools = [];
jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({ init: jest.fn(), getTools: jest.fn().mockImplementation(async () => mockMcpTools), close: jest.fn() }))
}));
jest.mock('../src/utils/browser-secrets', () => ({ ...jest.requireActual('../src/utils/browser-secrets'), readSecretNames: jest.fn().mockReturnValue(['BANK_PASSWORD']) }));

describe('per-turn blocks of the system instruction', () => {
    const dbPath = path.join(__dirname, 'test_prompt_turn_blocks.db');
    let agent, spies;

    beforeEach(() => {
        mockMcpTools = [];
        fs.rmSync(dbPath, { recursive: true, force: true });
        agent = new Agent({ googleApiKey: 'test_key', interface: { on: jest.fn(), emit: jest.fn(), send: jest.fn() } });
        agent.db = new AgentDB(dbPath);
        agent.db.init();
        const reply = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
        const session = {
            sendMessage: jest.fn().mockResolvedValue({ response: reply }),
            sendMessageStream: jest.fn().mockResolvedValue({ stream: (async function* () { yield { text: () => 'ok' }; })(), response: Promise.resolve(reply) })
        };
        agent.client = { models: { generateContent: jest.fn() }, chats: { create: jest.fn().mockReturnValue(session) } };
        agent.smartContext.getContext = jest.fn().mockResolvedValue([]);
        spies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        spies.forEach(s => s.mockRestore());
        agent.db.close();
        fs.rmSync(dbPath, { recursive: true, force: true });
    });

    const promptOf = async (message, decision = { model: 'FLASH', toolMode: 'STANDARD', toolGroups: [] }) => {
        agent.router.route = jest.fn().mockResolvedValue(decision);
        await agent.processMessage({ role: 'user', ...message }, jest.fn());
        return agent.client.chats.create.mock.calls[0][0].config.systemInstruction;
    };
    const voiceNote = [{ text: '[Voice]' }, { inlineData: { mimeType: 'audio/m4a', data: 'AAAA' } }];

    test('a recording from the iOS shortcut is heard, not dictated', async () => {
        const p = await promptOf({ source: 'ios_shortcut', content: '[Voice]', parts: voiceNote, metadata: { chatId: 'ios-1' } });
        expect(p).toContain("**AUDIO INPUT**: You are hearing the owner's own recording.");
        expect(p).not.toContain('iOS Voice Dictation');
    });

    test('typed iOS text keeps the dictation safeguard', async () => {
        const p = await promptOf({ source: 'ios_shortcut', content: 'turn on the light', metadata: { chatId: 'ios-2' } });
        expect(p).toContain('**DICTATION SAFEGUARD**');
        expect(p).not.toContain('**AUDIO INPUT**');
    });

    test('text-only says it overrides the audio rules, even from iOS', async () => {
        const p = await promptOf({ source: 'ios_shortcut', content: 'hello', metadata: { chatId: 'ios-3', replyMode: 'text' } });
        expect(p).toContain("DO NOT call the 'replyWithAudio' tool, even if the message came in as voice or from iOS.");
        expect(p).toContain('This overrides the AUDIO PROTOCOL above.');
        expect(p).not.toContain("YOU MUST call the 'replyWithAudio' tool");
    });

    test('native search declares no tool, so the prompt does not order replyWithAudio', async () => {
        // NATIVE_ONLY keeps native search even on an audio turn; the old block
        // still said "YOU MUST call the 'replyWithAudio' tool".
        agent.settings = { ...(agent.settings || {}), search_strategy: { mode: 'NATIVE_ONLY' } };
        const p = await promptOf({ source: 'ios_shortcut', content: 'what is the weather', metadata: { chatId: 'ios-4' } }, { model: 'FLASH', toolMode: 'SEARCH', toolGroups: [] });
        expect(p).toContain("The 'replyWithAudio' tool is not loaded. Do not try to call it.");
        expect(p).not.toContain("YOU MUST call the 'replyWithAudio' tool");
        expect(agent.client.chats.create.mock.calls[0][0].config.tools).toEqual([{ googleSearch: {} }]);
    });

    test('an iOS turn in standard mode is still told to speak', async () => {
        const p = await promptOf({ source: 'ios_shortcut', content: 'hello there', metadata: { chatId: 'ios-5' } });
        expect(p).toContain("YOU MUST call the 'replyWithAudio' tool");
    });

    test('the impersonation block is clean text and points at his own messages', async () => {
        const p = await promptOf({ source: 'web', content: 'draft a reply for me', metadata: { chatId: 'web-1', replyMode: 'text' } });
        expect(p).toContain('IF you are asked to draft a message for the user');
        expect(p).toContain('marks "Me"; "Them" is the contact. Mirror him, never the contact.');
        expect(p).toContain('Do not sound like an AI. Use "I", not "Deedee".');
        expect(p).not.toContain('** Analyze History **');
        expect(p).not.toContain('capitalization(lowercase ?)');
    });

    test('a scanner sub-agent with no browser tool does not read the saved secret names', async () => {
        const p = await promptOf({ source: 'subagent', content: 'scan the inbox', metadata: { chatId: 'subagent-1', isSubAgent: true, isLightweight: true, lightweight: true, forceModel: 'FLASH', allowedTools: ['getFact'] } });
        expect(p).toContain('performing a delegated sub-task');
        expect(p).not.toContain('BANK_PASSWORD');
        expect(p).not.toContain('browser_');
    });

    test('a sub-agent that holds browser tools still reads them', async () => {
        mockMcpTools = [{ name: 'browser_navigate', description: 'go', parameters: { type: 'object', properties: {} }, serverName: 'browser' }];
        const p = await promptOf({ source: 'subagent', content: 'open the page', metadata: { chatId: 'subagent-2', isSubAgent: true, isLightweight: true, lightweight: true, forceModel: 'FLASH', allowedTools: ['server:browser'] } });
        expect(p).toContain('BANK_PASSWORD');
        expect(p).toContain('browser_');
    });
});
