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
    const proto = require('../src/agent').Agent.prototype;
    return {
        db,
        interface: { send: jest.fn().mockResolvedValue(true) },
        _ownerWaIds: null,
        _interfaceMirrorInstalled: false,
        _getOwnerWaIds: proto._getOwnerWaIds,
        _normalizeWaChatId: proto._normalizeWaChatId,
        _mirrorToOwnerChat: proto._mirrorToOwnerChat,
        _installInterfaceMirror: proto._installInterfaceMirror
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

    test('mirrors smart-notification payload (source=scheduler, platform=whatsapp, bare-digit chatId)', async () => {
        // Matches scheduler.js:333 exactly: source='scheduler', platform=channel,
        // metadata.chatId is bare digits (no @suffix).
        const payload = {
            source: 'scheduler',
            content: 'Smart notification: someone needs you.',
            type: 'text',
            metadata: { chatId: OWNER_PHONE },
            platform: 'whatsapp',
            isNotification: true
        };
        await agent.interface.send(payload);
        await flush();

        const rows = db.getHistoryForChat(OWNER_LID, 5);
        expect(rows.length).toBe(1);
        expect(rows[0].parts[0].text).toBe('Smart notification: someone needs you.');
    });

    test('does NOT mirror scheduler payload routed to a non-whatsapp channel', async () => {
        const payload = {
            source: 'scheduler',
            content: 'Telegram-bound notification',
            type: 'text',
            metadata: { chatId: OWNER_PHONE },
            platform: 'telegram'
        };
        await agent.interface.send(payload);
        await flush();

        const rows = db.getHistoryForChat(OWNER_LID, 5);
        expect(rows.length).toBe(0);
    });
});

describe('Agent proactive-mirror — LID resolve retry on failure', () => {
    let db;
    let agent;
    let axios;

    beforeEach(() => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        db = new AgentDB(tmpDir);
        db.setAgentSetting('owner_phone', OWNER_PHONE);
        agent = makeAgentStub(db);
        agent._installInterfaceMirror();
        axios = require('axios');
    });

    afterEach(() => {
        if (db) db.close();
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        axios.get.mockReset();
    });

    function flush() {
        return new Promise(resolve => setImmediate(resolve)).then(
            () => new Promise(resolve => setImmediate(resolve))
        );
    }

    test('retries LID resolve on next send after a failure (no permanent stale cache)', async () => {
        axios.get.mockReset();
        // First call: simulate Baileys not connected yet.
        axios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        // Second call: now connected, returns LID.
        axios.get.mockResolvedValueOnce({
            data: { lid: OWNER_LID, phoneJid: OWNER_PHONE_JID }
        });

        // First send happens while resolve fails. Mirror saves to phoneJid
        // (degraded but not stale-cached).
        await agent.interface.send({
            source: 'whatsapp',
            content: 'first send during outage',
            metadata: { chatId: OWNER_PHONE_JID },
            type: 'text'
        });
        await flush();

        // Bypass the 30s retry-throttle for this test — pretend enough time passed.
        agent._ownerLidRetryAfterMs = Date.now() - 1;

        // Second send: LID now resolves → mirror saves to LID chat.
        await agent.interface.send({
            source: 'whatsapp',
            content: 'second send after recovery',
            metadata: { chatId: OWNER_PHONE_JID },
            type: 'text'
        });
        await flush();

        // The second send's mirror landed in the LID chat thread.
        const lidRows = db.getHistoryForChat(OWNER_LID, 10);
        expect(lidRows.map(r => r.parts[0].text)).toContain('second send after recovery');
        // Both axios calls happened (i.e. we did NOT permanently cache the failure).
        expect(axios.get).toHaveBeenCalledTimes(2);
    });

    test('throttles LID resolve retries within 30s window', async () => {
        axios.get.mockReset();
        axios.get
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockRejectedValueOnce(new Error('ECONNREFUSED'));

        // Two sends back-to-back during outage. Only one resolve attempt should happen.
        await agent.interface.send({
            source: 'whatsapp',
            content: 'first',
            metadata: { chatId: OWNER_PHONE_JID },
            type: 'text'
        });
        await flush();
        await agent.interface.send({
            source: 'whatsapp',
            content: 'second',
            metadata: { chatId: OWNER_PHONE_JID },
            type: 'text'
        });
        await flush();

        expect(axios.get).toHaveBeenCalledTimes(1);
    });
});
