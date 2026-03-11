
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

    describe('resolveIdentity', () => {
        test('Strategy 1: should resolve by phone JID', () => {
            const contact = { id: '5551234@s.whatsapp.net', lid: '999888777666555@lid', name: 'Alice' };
            ev.emit('contacts.upsert', [contact]);

            const result = store.resolveIdentity('5551234@s.whatsapp.net');
            expect(result.phoneJid).toBe('5551234@s.whatsapp.net');
            expect(result.lid).toBe('999888777666555@lid');
            expect(result.name).toBe('Alice');
            expect(result.allJids).toContain('5551234@s.whatsapp.net');
            expect(result.allJids).toContain('999888777666555@lid');
        });

        test('Strategy 2: should resolve by LID', () => {
            const contact = { id: '5551234@s.whatsapp.net', lid: '999888777666555@lid', name: 'Bob' };
            ev.emit('contacts.upsert', [contact]);

            const result = store.resolveIdentity('999888777666555@lid');
            expect(result.phoneJid).toBe('5551234@s.whatsapp.net');
            expect(result.lid).toBe('999888777666555@lid');
            expect(result.name).toBe('Bob');
        });

        test('Strategy 3: should resolve by raw digits (phone number)', () => {
            const contact = { id: '5551234@s.whatsapp.net', name: 'Charlie' };
            ev.emit('contacts.upsert', [contact]);

            const result = store.resolveIdentity('5551234');
            expect(result.phoneJid).toBe('5551234@s.whatsapp.net');
            expect(result.name).toBe('Charlie');
        });

        test('Strategy 4: should resolve by fuzzy suffix match', () => {
            const contact = { id: '549351234567@s.whatsapp.net', name: 'Diana' };
            ev.emit('contacts.upsert', [contact]);

            // Use last 7 digits with different country code prefix
            const result = store.resolveIdentity('541234567');
            expect(result.phoneJid).toBe('549351234567@s.whatsapp.net');
            expect(result.name).toBe('Diana');
        });

        test('should return inferred identity when no contact found (phone JID)', () => {
            const result = store.resolveIdentity('9876543@s.whatsapp.net');
            expect(result.phoneJid).toBe('9876543@s.whatsapp.net');
            expect(result.lid).toBeNull();
            expect(result.name).toBeNull();
            expect(result.allJids).toEqual(['9876543@s.whatsapp.net']);
        });

        test('should return inferred LID when no contact found for LID input', () => {
            const result = store.resolveIdentity('999888777666555@lid');
            expect(result.phoneJid).toBeNull();
            expect(result.lid).toBe('999888777666555@lid');
            expect(result.name).toBeNull();
        });

        test('should handle null/empty/undefined input', () => {
            expect(store.resolveIdentity(null)).toEqual({ phoneJid: null, lid: null, name: null, allJids: [] });
            expect(store.resolveIdentity('')).toEqual({ phoneJid: null, lid: null, name: null, allJids: [] });
            expect(store.resolveIdentity(undefined)).toEqual({ phoneJid: null, lid: null, name: null, allJids: [] });
        });

        test('should prefer notify name when name is absent', () => {
            const contact = { id: '5551234@s.whatsapp.net', notify: 'NotifyName' };
            ev.emit('contacts.upsert', [contact]);

            const result = store.resolveIdentity('5551234@s.whatsapp.net');
            expect(result.name).toBe('NotifyName');
        });
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
