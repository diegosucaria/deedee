const { AgentDB } = require('../src/db');
const fs = require('fs');
const path = require('path');

const tmpDir = path.join(__dirname, 'tmp_mirror_db');

// Stub for axios so the LID resolve call doesn't try to hit the network.
jest.mock('axios', () => ({
    get: jest.fn().mockResolvedValue({
        data: { lid: '264664608964626@lid', phoneJid: '5491111111111@s.whatsapp.net' }
    }),
    post: jest.fn().mockResolvedValue({ data: {} })
}));

const OWNER_PHONE = '5491111111111';
const OWNER_PHONE_JID = `${OWNER_PHONE}@s.whatsapp.net`;
const OWNER_LID = '264664608964626@lid';

function makeAgentStub(db) {
    return {
        db,
        interface: { send: jest.fn().mockResolvedValue(true) },
        _ownerWaIds: null,
        _interfaceMirrorInstalled: false,
        _getOwnerWaIds: require('../src/agent').Agent.prototype._getOwnerWaIds,
        _mirrorToOwnerChat: require('../src/agent').Agent.prototype._mirrorToOwnerChat,
        _installInterfaceMirror: require('../src/agent').Agent.prototype._installInterfaceMirror
    };
}

describe('Agent proactive-mirror wrapper', () => {
    let db;
    let agent;

    beforeEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        db = new AgentDB(tmpDir);
        db.setAgentSetting('owner_phone', OWNER_PHONE);
        agent = makeAgentStub(db);
        agent._installInterfaceMirror();
    });

    afterEach(() => {
        if (db) db.close();
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    });

    function flush() {
        // Wait for setImmediate-deferred mirror to run.
        return new Promise(resolve => setImmediate(resolve)).then(
            () => new Promise(resolve => setImmediate(resolve))
        );
    }

    test('mirrors a dream-style send (no id, owner JID target)', async () => {
        const payload = {
            source: 'whatsapp',
            content: 'I dreamt I was installing Office.',
            metadata: { chatId: OWNER_PHONE_JID, session: 'assistant' },
            type: 'text'
        };
        await agent.interface.send(payload);
        await flush();

        const rows = db.getHistoryForChat(OWNER_LID, 5);
        expect(rows.length).toBe(1);
        expect(rows[0].parts[0].text).toBe('I dreamt I was installing Office.');
    });

    test('does NOT duplicate a reply already saved by the main loop (same id)', async () => {
        const id = 'reply-id-abc';
        // Simulate main loop: save first
        db.saveMessage({
            id,
            role: 'assistant',
            content: 'Main loop reply.',
            source: 'whatsapp:assistant',
            metadata: { chatId: OWNER_LID }
        });
        // Now interface.send fires the wrapper with the same id
        await agent.interface.send({
            id,
            source: 'whatsapp',
            content: 'Main loop reply.',
            metadata: { chatId: OWNER_PHONE_JID, session: 'assistant' },
            type: 'text'
        });
        await flush();

        const rows = db.getHistoryForChat(OWNER_LID, 10);
        expect(rows.length).toBe(1);
    });

    test('does NOT mirror sends to a non-owner contact', async () => {
        const payload = {
            source: 'whatsapp',
            content: 'Hello stranger',
            metadata: { chatId: '9999999999@s.whatsapp.net', session: 'assistant' },
            type: 'text'
        };
        await agent.interface.send(payload);
        await flush();

        const rows = db.getHistoryForChat(OWNER_LID, 10);
        expect(rows.length).toBe(0);
    });

    test('does NOT mirror non-WhatsApp sources (e.g. web socket events)', async () => {
        const payload = {
            source: 'web',
            type: 'session_update',
            content: '{}',
            metadata: { chatId: OWNER_LID }
        };
        await agent.interface.send(payload);
        await flush();

        const rows = db.getHistoryForChat(OWNER_LID, 10);
        expect(rows.length).toBe(0);
    });

    test('mirror still runs if main-loop saves AFTER the send (xAI-style ordering)', async () => {
        const id = 'xai-reply-id';
        const payload = {
            id,
            source: 'whatsapp',
            content: 'xAI streamed reply',
            metadata: { chatId: OWNER_PHONE_JID, session: 'assistant' },
            type: 'text'
        };
        // Send first (mirror is queued via setImmediate)
        await agent.interface.send(payload);
        // Main loop saves immediately after, synchronously, before mirror runs
        db.saveMessage({
            id,
            role: 'assistant',
            content: 'xAI streamed reply',
            source: 'whatsapp:assistant',
            metadata: { chatId: OWNER_LID }
        });
        await flush();

        // Mirror should be a no-op now; only one row
        const rows = db.getHistoryForChat(OWNER_LID, 10);
        expect(rows.length).toBe(1);
    });

    test('handles split source like "whatsapp:assistant"', async () => {
        const payload = {
            source: 'whatsapp:assistant',
            content: 'Smart notification',
            metadata: { chatId: OWNER_PHONE_JID },
            type: 'text'
        };
        await agent.interface.send(payload);
        await flush();

        const rows = db.getHistoryForChat(OWNER_LID, 5);
        expect(rows.length).toBe(1);
    });
});
