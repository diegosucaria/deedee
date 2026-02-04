
const { SQLiteStore } = require('../src/whatsapp');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const TEST_DB = path.join(__dirname, `test_whatsapp_${Date.now()}_${Math.random()}.db`);

describe('WhatsApp SQLiteStore', () => {
    let store;
    let ev;

    beforeEach(() => {
        if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
        store = new SQLiteStore(TEST_DB);
        ev = new EventEmitter();
        store.bind(ev);
    });

    afterEach(() => {
        if (store && store.db && store.db.open) store.db.close();
        if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
        // Clean up WAL file if exists
        const wal = `${TEST_DB}-wal`;
        const shm = `${TEST_DB}-shm`;
        if (fs.existsSync(wal)) fs.unlinkSync(wal);
        if (fs.existsSync(shm)) fs.unlinkSync(shm);
    });

    test('should save and retrieve contacts', () => {
        const contact = { id: '123@s.whatsapp.net', name: 'Alice', notify: 'Alice', lid: 'lid1' };
        ev.emit('contacts.upsert', [contact]);

        const saved = store.getContact('123@s.whatsapp.net');
        expect(saved).toBeDefined();
        expect(saved.name).toBe('Alice');
        expect(saved.id).toBe('123@s.whatsapp.net');
    });

    test('should save and retrieve messages', async () => {
        const jid = '123@s.whatsapp.net';
        const msgs = [
            {
                key: { remoteJid: jid, id: 'msg1', fromMe: false },
                messageTimestamp: 1000,
                message: { conversation: 'Hello' }
            },
            {
                key: { remoteJid: jid, id: 'msg2', fromMe: true },
                messageTimestamp: 2000,
                message: { conversation: 'Hi there' }
            }
        ];

        // Type 'notify' triggers insert
        ev.emit('messages.upsert', { messages: msgs, type: 'notify' });

        // Wait for queue to drain (Queue flush is 500ms)
        await new Promise(r => setTimeout(r, 600));

        const history = store.getChatHistory(jid);

        expect(history.length).toBe(2);
        // Order is DESC by default in getChatHistory, but the loop returns rows reversed?
        // Let's check logic: rows = ORDER BY timestamp DESC. returns rows.reverse().
        // So history[0] should be oldest.
        expect(history[0].key.id).toBe('msg1');
        expect(history[1].key.id).toBe('msg2');
    });

    test('should update contacts', () => {
        const contact = { id: '123@s.whatsapp.net', name: 'Alice' };
        ev.emit('contacts.upsert', [contact]);

        const update = { id: '123@s.whatsapp.net', notify: 'Alice Updated' };
        ev.emit('contacts.update', [update]);

        const saved = store.getContact('123@s.whatsapp.net');
        expect(saved.name).toBe('Alice');
        expect(saved.notify).toBe('Alice Updated');
    });

    test('getRecentChats should return correct summary', async () => {
        const jid = '123@s.whatsapp.net';
        const msgs = [
            {
                key: { remoteJid: jid, id: 'msg1', fromMe: false },
                messageTimestamp: 1000,
                message: { conversation: 'First' }
            },
            {
                key: { remoteJid: jid, id: 'msg2', fromMe: true },
                messageTimestamp: 2000,
                message: { conversation: 'Second' }
            }
        ];
        ev.emit('messages.upsert', { messages: msgs, type: 'notify' });

        // Wait for queue
        await new Promise(r => setTimeout(r, 600));

        const recent = store.getRecentChats();
        expect(recent.length).toBe(1);
        expect(recent[0].jid).toBe(jid);
        expect(recent[0].msgCount).toBe(2);
        expect(recent[0].lastTimestamp).toBe(2000000); // 2000 * 1000
    });

    test('getContactByLid should return full contact object', () => {
        const contact = { id: '5551234@s.whatsapp.net', lid: '123456789012345@lid', name: 'Test User' };
        ev.emit('contacts.upsert', [contact]);

        const resolved = store.getContactByLid('123456789012345@lid');
        expect(resolved).not.toBeNull();
        expect(typeof resolved).toBe('object');
        expect(resolved.id).toBe('5551234@s.whatsapp.net');
        expect(resolved.name).toBe('Test User');
    });

    test('getChatHistory should smart-resolve JID from LID', async () => {
        const realJid = '5551234@s.whatsapp.net';
        const lidJid = '123456789012345@lid'; // 15 digits
        const wrongJid = '123456789012345@s.whatsapp.net'; // 15 digits, wrong domain

        // 1. Setup Contact Map
        const contact = { id: realJid, lid: lidJid, name: 'LID User' };
        ev.emit('contacts.upsert', [contact]);

        // 2. Setup Message History for REAL JID
        const msgs = [{
            key: { remoteJid: realJid, id: 'msg1', fromMe: false },
            messageTimestamp: 1000,
            message: { conversation: 'LID Test' }
        }];
        ev.emit('messages.upsert', { messages: msgs, type: 'notify' });
        await new Promise(r => setTimeout(r, 600));

        // 3. Test A: Explicit LID lookup
        const historyA = store.getChatHistory(lidJid);
        expect(historyA.length).toBe(1);
        expect(historyA[0].message.conversation).toBe('LID Test');

        // 4. Test B: Wrong Domain lookup (The Fix Verification)
        // If we query '123456789@s.whatsapp.net', it should realize it's a LID number
        // and resolve to '5551234@s.whatsapp.net' via '123456789@lid'
        const historyB = store.getChatHistory(wrongJid);
        expect(historyB.length).toBe(1);
        expect(historyB[0].message.conversation).toBe('LID Test');
    });
});
