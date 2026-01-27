
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
    });

    test('should save and retrieve contacts', () => {
        const contact = { id: '123@s.whatsapp.net', name: 'Alice', notify: 'Alice', lid: 'lid1' };
        ev.emit('contacts.upsert', [contact]);

        const saved = store.getContact('123@s.whatsapp.net');
        expect(saved).toBeDefined();
        expect(saved.name).toBe('Alice');
        expect(saved.id).toBe('123@s.whatsapp.net');
    });

    test('should save and retrieve messages', () => {
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

        const history = store.getChatHistory(jid);
        // getChatHistory returns parsed message objects (simplified or full depending on implementation?)
        // The implementation in SQLiteStore.getChatHistory returns the raw JSON.parse(data)
        // Wait, the test checks the STORE method directly, which returns JSON object of the msg.

        expect(history.length).toBe(2);
        // Order is ASC by timestamp (Oldest First)
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

    test('getRecentChats should return correct summary', () => {
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

        const recent = store.getRecentChats();
        expect(recent.length).toBe(1);
        expect(recent[0].jid).toBe(jid);
        expect(recent[0].msgCount).toBe(2);
        expect(recent[0].lastTimestamp).toBe(2000000); // 2000 * 1000
        expect(recent[0].snippets[recent[0].snippets.length - 1]).toBe('Second');
    });
    test('getContactByLid should return full contact object', () => {
        const contact = { id: '5551234@s.whatsapp.net', lid: '123456789@lid', name: 'Test User' };
        ev.emit('contacts.upsert', [contact]);

        const resolved = store.getContactByLid('123456789@lid');
        expect(resolved).not.toBeNull();
        expect(typeof resolved).toBe('object');
        // This is where it fails if it returns a string
        expect(resolved.id).toBe('5551234@s.whatsapp.net');
        expect(resolved.name).toBe('Test User');
    });
});
