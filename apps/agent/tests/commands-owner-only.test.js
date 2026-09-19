/**
 * Slash commands wipe history, stop every run and forge inbound messages.
 * The handler used to run for any text that reached processMessage, before
 * the rule that ignores contacts' messages: "/clear all" sent to the owner's
 * WhatsApp by anyone, posted in a watched Slack channel, written in a group,
 * or handed to a sub-agent as its task, wiped every chat.
 */
const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const path = require('path');
const fs = require('fs');

jest.mock('axios');
jest.mock('../src/mcp-manager', () => ({
    MCPManager: jest.fn().mockImplementation(() => ({ init: jest.fn(), getTools: jest.fn().mockResolvedValue([]), close: jest.fn() }))
}));

const OWNER_DIGITS = '15550100';
const OWNER_TG = '700100';

describe('only text the owner typed runs a slash command', () => {
    const dbPath = path.join(__dirname, 'test_commands_owner_only.db');
    let agent, handle, spies, savedTg;

    beforeEach(() => {
        savedTg = process.env.ALLOWED_TELEGRAM_IDS;
        process.env.ALLOWED_TELEGRAM_IDS = OWNER_TG;
        fs.rmSync(dbPath, { recursive: true, force: true });
        agent = new Agent({ googleApiKey: 'test_key', interface: { on: jest.fn(), emit: jest.fn(), send: jest.fn().mockResolvedValue(true) } });
        agent.db = new AgentDB(dbPath);
        agent.db.init();
        agent.settings = { ...(agent.settings || {}), owner_phone: `+${OWNER_DIGITS}` };
        const reply = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
        const session = {
            sendMessage: jest.fn().mockResolvedValue({ response: reply }),
            sendMessageStream: jest.fn().mockResolvedValue({ stream: (async function* () { yield { text: () => 'ok' }; })(), response: Promise.resolve(reply) })
        };
        agent.client = { models: { generateContent: jest.fn() }, chats: { create: jest.fn().mockReturnValue(session) } };
        agent.smartContext.getContext = jest.fn().mockResolvedValue([]);
        agent.router.route = jest.fn().mockResolvedValue({ model: 'FLASH', toolMode: 'STANDARD', toolGroups: [] });
        // Every command goes through handle(); a true return means "it was a command, and it ran".
        handle = jest.spyOn(agent.commandHandler, 'handle').mockResolvedValue(true);
        spies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        if (savedTg === undefined) delete process.env.ALLOWED_TELEGRAM_IDS; else process.env.ALLOWED_TELEGRAM_IDS = savedTg;
        spies.forEach(s => s.mockRestore());
        agent.db.close();
        fs.rmSync(dbPath, { recursive: true, force: true });
    });

    const send = (source, metadata, content = '/clear all') =>
        agent.processMessage({ content, role: 'user', source, metadata }, jest.fn());

    test.each([
        ['a contact writing to the owner\'s own WhatsApp', 'whatsapp:user', { chatId: '15550199@s.whatsapp.net' }],
        ['the owner\'s own text in that mirrored account (it is not his chat with the assistant)', 'whatsapp:user', { chatId: `${OWNER_DIGITS}@s.whatsapp.net` }],
        ['a Slack message in a watched channel', 'slack', { chatId: 'C0001' }],
        ['a stranger writing to the assistant\'s number', 'whatsapp:assistant', { chatId: '15550199@s.whatsapp.net' }],
        ['a group the assistant sits in, even when the owner writes there', 'whatsapp:assistant', { chatId: '100000000000001@g.us', isGroup: true }],
        ['a Telegram user who is not the owner', 'telegram', { chatId: '999' }],
        ['a sub-agent whose task a model wrote', 'subagent', { chatId: 'subagent-1', isSubAgent: true }],
        ['a web-sourced message that claims to be a sub-agent', 'web', { chatId: 'web-1', isSubAgent: true }],
        ['a scheduled job whose prompt starts with a slash', 'scheduler', { chatId: 'scheduled_x_1', jobName: 'x' }],
        ['a source we do not know', 'something_new', { chatId: 'x' }],
    ])('not a command: %s', async (_label, source, metadata) => {
        await send(source, metadata);
        expect(handle).not.toHaveBeenCalled();
    });

    test.each([
        ['the web UI, behind his login', 'web', { chatId: 'web-1', replyMode: 'text' }],
        ['the iOS shortcut, behind his token', 'ios_shortcut', { chatId: 'ios-1' }],
        ['the API, behind his token', 'api', { chatId: 'api-1' }],
        ['his own chat with the assistant on WhatsApp', 'whatsapp:assistant', { chatId: `${OWNER_DIGITS}@s.whatsapp.net` }],
        ['his Telegram chat', 'telegram', { chatId: OWNER_TG }],
    ])('a command: %s', async (_label, source, metadata) => {
        await send(source, metadata, '/stop');
        expect(handle).toHaveBeenCalledTimes(1);
    });

    test('a sub-agent\'s slash text goes to the model as plain text', async () => {
        await send('subagent', { chatId: 'subagent-1', isSubAgent: true, forceModel: 'FLASH' });
        expect(handle).not.toHaveBeenCalled();
        expect(agent.client.chats.create).toHaveBeenCalled();
    });

    test('a contact\'s slash text is still stored and ignored like any of their messages', async () => {
        const wipe = jest.spyOn(agent.db, 'clearAllHistory');
        await send('whatsapp:user', { chatId: '15550199@s.whatsapp.net' });
        expect(wipe).not.toHaveBeenCalled();
        expect(agent.client.chats.create).not.toHaveBeenCalled();
    });

    test('an owner lookup that fails means no', async () => {
        jest.spyOn(agent.approvals, '_isOwnerChat').mockRejectedValue(new Error('lookup down'));
        await send('whatsapp:assistant', { chatId: `${OWNER_DIGITS}@s.whatsapp.net` });
        expect(handle).not.toHaveBeenCalled();
    });
});
