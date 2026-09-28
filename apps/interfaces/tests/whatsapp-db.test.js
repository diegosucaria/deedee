
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

    describe('getMessagesByDate', () => {
        // Build a timestamp inside the local day the test asks for, so the
        // query's 'localtime' conversion matches wherever the test runs.
        const dayStart = new Date(2026, 0, 15, 12, 0, 0); // 15 Jan 2026, local noon
        const dateStr = '2026-01-15';
        const seconds = Math.floor(dayStart.getTime() / 1000);

        beforeEach(async () => {
            ev.emit('contacts.upsert', [{ id: '5551234@s.whatsapp.net', name: 'Contact', notify: 'Contact' }]);
            ev.emit('messages.upsert', {
                type: 'notify',
                messages: [
                    {
                        key: { remoteJid: '5551234@s.whatsapp.net', id: 'a', fromMe: false },
                        messageTimestamp: seconds,
                        message: { conversation: 'one to one' }
                    },
                    {
                        key: { remoteJid: '5551234@s.whatsapp.net', id: 'b', fromMe: true },
                        messageTimestamp: seconds + 60,
                        message: { conversation: 'reply' }
                    },
                    {
                        key: { remoteJid: '9999@g.us', id: 'c', fromMe: false },
                        messageTimestamp: seconds + 120,
                        message: { conversation: 'group chatter' }
                    },
                    {
                        key: { remoteJid: '5551234@s.whatsapp.net', id: 'd', fromMe: false },
                        messageTimestamp: seconds - 86400 * 3,
                        message: { conversation: 'another day' }
                    }
                ]
            });
            await new Promise(r => setTimeout(r, 600));
        });

        test('returns that day only, without group chats', () => {
            const rows = store.getMessagesByDate(dateStr);
            expect(rows.map(r => r.content)).toEqual(['one to one', 'reply']);
            expect(rows.map(r => r.role)).toEqual(['user', 'assistant']);
            expect(rows.every(r => r.source === 'whatsapp:user')).toBe(true);
            expect(JSON.parse(rows[0].metadata)).toEqual({
                chatId: '5551234@s.whatsapp.net',
                session: 'user',
                notifyName: 'Contact'
            });
        });

        test('returns [] for a day with nothing', () => {
            expect(store.getMessagesByDate('2026-01-16')).toEqual([]);
        });
    });

    describe('resolveIdentity', () => {
        test('Strategy 1: should resolve by phone JID', () => {
            const contact = { id: '5551234@s.whatsapp.net', lid: '100000000000001@lid', name: 'Alice' };
            ev.emit('contacts.upsert', [contact]);

            const result = store.resolveIdentity('5551234@s.whatsapp.net');
            expect(result.phoneJid).toBe('5551234@s.whatsapp.net');
            expect(result.lid).toBe('100000000000001@lid');
            expect(result.name).toBe('Alice');
            expect(result.allJids).toContain('5551234@s.whatsapp.net');
            expect(result.allJids).toContain('100000000000001@lid');
        });

        test('Strategy 2: should resolve by LID', () => {
            const contact = { id: '5551234@s.whatsapp.net', lid: '100000000000001@lid', name: 'Bob' };
            ev.emit('contacts.upsert', [contact]);

            const result = store.resolveIdentity('100000000000001@lid');
            expect(result.phoneJid).toBe('5551234@s.whatsapp.net');
            expect(result.lid).toBe('100000000000001@lid');
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
            const contact = { id: '549000001111@s.whatsapp.net', name: 'Diana' };
            ev.emit('contacts.upsert', [contact]);

            // Use last 7 digits with different country code prefix
            const result = store.resolveIdentity('540001111');
            expect(result.phoneJid).toBe('549000001111@s.whatsapp.net');
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
            const result = store.resolveIdentity('100000000000001@lid');
            expect(result.phoneJid).toBeNull();
            expect(result.lid).toBe('100000000000001@lid');
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

        // The last 7 digits of this WhatsApp ID and of this group id are the
        // stranger's. A suffix match used to hand back the stranger's number.
        test('a WhatsApp ID never takes the number of a contact whose digits end the same way', () => {
            ev.emit('contacts.upsert', [{ id: '5490000000002@s.whatsapp.net', name: 'Stranger' }]);

            const result = store.resolveIdentity('100000000000002@lid');
            expect(result.phoneJid).toBeNull();
            expect(result.name).toBeNull();
        });

        test('a group id never takes the number of a contact whose digits end the same way', () => {
            ev.emit('contacts.upsert', [{ id: '5490000000002@s.whatsapp.net', name: 'Stranger' }]);

            expect(store.resolveIdentity('120000000000000002@g.us').phoneJid).toBeNull();
        });

        test('a number typed with a 00 prefix still finds the contact', () => {
            ev.emit('contacts.upsert', [{ id: '1110000000001@s.whatsapp.net', name: 'Alice' }]);

            expect(store.resolveIdentity('001110000000001').phoneJid).toBe('1110000000001@s.whatsapp.net');
        });

        test('guess: false never matches by the last digits (an address WhatsApp gave is exact)', () => {
            ev.emit('contacts.upsert', [{ id: '5490000000002@s.whatsapp.net', name: 'Stranger' }]);

            expect(store.resolveIdentity('1110000000002@s.whatsapp.net', { guess: false }).phoneJid).toBe('1110000000002@s.whatsapp.net');
            expect(store.resolveIdentity('1110000000002@s.whatsapp.net').phoneJid).toBe('5490000000002@s.whatsapp.net');
        });

        // readChatHistory turns bare digits into "<digits>@s.whatsapp.net". The
        // digits of a WhatsApp ID we have seen used to find a stranger's chat.
        test('the digits of a known WhatsApp ID read that chat, never a stranger whose number ends the same way', async () => {
            ev.emit('contacts.upsert', [{ id: '5490000000002@s.whatsapp.net', name: 'Stranger' }]);
            ev.emit('messages.upsert', {
                messages: [{ key: { remoteJid: '100000000000002@lid', id: 'msg1', fromMe: false }, messageTimestamp: 1000, message: { conversation: 'From the ID chat' } }],
                type: 'notify'
            });
            await new Promise(r => setTimeout(r, 600));

            for (const input of ['100000000000002', '100000000000002@s.whatsapp.net']) {
                const result = store.resolveIdentity(input);
                expect(result.phoneJid).toBeNull();
                expect(result.lid).toBe('100000000000002@lid');
            }
            const history = store.getChatHistory('100000000000002@s.whatsapp.net');
            expect(history.map(m => m.message.conversation)).toEqual(['From the ID chat']);
        });

        test('a send to a mistyped number does not hide the saved contact', async () => {
            ev.emit('contacts.upsert', [{ id: '1110000000001@s.whatsapp.net', name: 'Alice' }]);
            ev.emit('messages.upsert', {
                messages: [{ key: { remoteJid: '110000000001@s.whatsapp.net', id: 'm1', fromMe: true }, messageTimestamp: 1000, message: { conversation: 'sent to the wrong form' } }],
                type: 'notify'
            });
            await new Promise(r => setTimeout(r, 600));

            expect(store.resolveIdentity('110000000001').phoneJid).toBe('1110000000001@s.whatsapp.net');
        });

        // listConversations lists a chat by its own address; reading that
        // address must give that chat, not a contact whose number ends the same.
        test('a chat\'s own address reads that chat, never a guessed contact', async () => {
            ev.emit('contacts.upsert', [{ id: '1110000000002@s.whatsapp.net', name: 'Alice' }]);
            ev.emit('messages.upsert', {
                messages: [
                    { key: { remoteJid: '5490000000002@s.whatsapp.net', id: 'm1', fromMe: false }, messageTimestamp: 1000, message: { conversation: 'from the chat' } },
                    { key: { remoteJid: '1110000000002@s.whatsapp.net', id: 'm2', fromMe: false }, messageTimestamp: 2000, message: { conversation: 'from Alice' } }
                ],
                type: 'notify'
            });
            await new Promise(r => setTimeout(r, 600));

            expect(store.getChatHistory('5490000000002@s.whatsapp.net').map(m => m.message.conversation)).toEqual(['from the chat']);
            expect(store.resolveIdentity('5490000000002').phoneJid).toBe('5490000000002@s.whatsapp.net');
        });

        test('recent chats never guess from a chat\'s own address', async () => {
            ev.emit('contacts.upsert', [{ id: '1110000000002@s.whatsapp.net', name: 'Alice' }]);
            ev.emit('messages.upsert', {
                messages: [{ key: { remoteJid: '5490000000002@s.whatsapp.net', id: 'msg1', fromMe: false }, messageTimestamp: 1000, message: { conversation: 'Hello' } }],
                type: 'notify'
            });
            await new Promise(r => setTimeout(r, 600));

            const [chat] = store.getRecentChats(5);
            expect(chat.jid).toBe('5490000000002@s.whatsapp.net');
            expect(chat.name).toBeUndefined();
        });
    });

    describe('linkLid', () => {
        const LID = '100000000000002@lid';
        const PHONE_JID = '5490000000001@s.whatsapp.net';

        afterEach(() => { delete process.env.WHATSAPP_LID_ALT; });

        test('a linked WhatsApp ID resolves both ways and leaves the contact list alone', () => {
            ev.emit('contacts.upsert', [{ id: LID, notify: 'Clinic' }]);

            expect(store.linkLid(PHONE_JID, LID)).toBe(true);

            expect(store.resolveIdentity(LID).phoneJid).toBe(PHONE_JID);
            expect(store.resolveIdentity(LID).name).toBeNull();
            expect(store.resolveIdentity('5490000000001').allJids).toEqual([PHONE_JID, LID]);
            expect(store.getContacts().map(c => c.id)).toEqual([LID]);
            expect(store.db.prepare('SELECT lid, phone_jid FROM lid_links').all()).toEqual([{ lid: LID, phone_jid: PHONE_JID }]);
            expect(store.linkLid(PHONE_JID, LID)).toBe(true);
        });

        // A named row made listConversations show the chat by name alone, and
        // readChatHistory cannot find a chat by name. WhatsApp sends the push
        // name as a contacts.update; it must not name a linked chat.
        test('recent chats list a linked chat under its number, even after a name update', async () => {
            ev.emit('contacts.upsert', [{ id: LID, notify: 'Clinic' }]);
            ev.emit('messages.upsert', {
                messages: [{ key: { remoteJid: LID, id: 'msg1', fromMe: false }, messageTimestamp: 1000, message: { conversation: 'Reminder' } }],
                type: 'notify'
            });
            await new Promise(r => setTimeout(r, 600));

            store.linkLid(PHONE_JID, LID);
            ev.emit('contacts.update', [{ id: PHONE_JID, notify: 'Clinic' }]);

            const [chat] = store.getRecentChats(5);
            expect(chat.jid).toBe(PHONE_JID);
            expect(chat.name).toBeUndefined();
        });

        test('a saved contact keeps its row and name; the link adds its WhatsApp ID', () => {
            ev.emit('contacts.upsert', [{ id: PHONE_JID, name: 'Alice' }]);

            expect(store.linkLid(PHONE_JID, LID)).toBe(true);

            expect(store.getContact(PHONE_JID).lid).toBeNull();
            const byLid = store.resolveIdentity(LID);
            expect([byLid.phoneJid, byLid.name]).toEqual([PHONE_JID, 'Alice']);
            expect(store.resolveIdentity(PHONE_JID).allJids).toEqual([PHONE_JID, LID]);
        });

        test('a number that already holds another WhatsApp ID keeps it, and so does an ID', () => {
            ev.emit('contacts.upsert', [{ id: PHONE_JID, name: 'Alice', lid: '100000000000001@lid' }]);
            const OTHER = '5490000000003@s.whatsapp.net';

            expect(store.linkLid(PHONE_JID, LID)).toBe(false);
            expect(store.linkLid(OTHER, '100000000000001@lid')).toBe(false);
            expect(store.linkLid(OTHER, '100000000000003@lid')).toBe(true);
            expect(store.linkLid(OTHER, LID)).toBe(false);
            expect(store.linkLid('5490000000004@s.whatsapp.net', '100000000000003@lid')).toBe(false);
            expect(store.resolveIdentity('100000000000003@lid').phoneJid).toBe(OTHER);
            expect(store.resolveIdentity(LID).phoneJid).toBeNull();
        });

        // A link saved while the number had no WhatsApp ID in contacts. When a
        // contact sync gives the number another ID, the old ID's chat must stay
        // its own, not show the number's current chat.
        test('a link goes stale once contacts give its number another WhatsApp ID', async () => {
            const OLD = '100000000000003@lid';
            const NOW = '100000000000001@lid';
            ev.emit('messages.upsert', {
                messages: [
                    { key: { remoteJid: OLD, id: 'm1', fromMe: false }, messageTimestamp: 1000, message: { conversation: 'from the old ID' } },
                    { key: { remoteJid: NOW, id: 'm2', fromMe: false }, messageTimestamp: 2000, message: { conversation: 'from the number now' } }
                ],
                type: 'notify'
            });
            await new Promise(r => setTimeout(r, 600));

            expect(store.linkLid(PHONE_JID, OLD)).toBe(true);
            ev.emit('contacts.upsert', [{ id: PHONE_JID, name: 'Alice', lid: NOW }]);

            expect(store.resolveIdentity(OLD).phoneJid).toBeNull();
            expect(store.getChatHistory(OLD).map(m => m.message.conversation)).toEqual(['from the old ID']);
            expect(store.resolveIdentity(PHONE_JID).allJids).toEqual([PHONE_JID, NOW]);
            // The stale link gives way to a new one.
            expect(store.linkLid('5490000000004@s.whatsapp.net', OLD)).toBe(true);
            expect(store.resolveIdentity(OLD).phoneJid).toBe('5490000000004@s.whatsapp.net');
        });

        test('a link goes stale once contacts give its WhatsApp ID another number', async () => {
            ev.emit('messages.upsert', {
                messages: [{ key: { remoteJid: LID, id: 'm1', fromMe: false }, messageTimestamp: 1000, message: { conversation: 'from the ID' } }],
                type: 'notify'
            });
            await new Promise(r => setTimeout(r, 600));

            expect(store.linkLid(PHONE_JID, LID)).toBe(true);
            ev.emit('contacts.upsert', [{ id: '5490000000004@s.whatsapp.net', name: 'Bob', lid: LID }]);

            expect(store.resolveIdentity(LID).phoneJid).toBe('5490000000004@s.whatsapp.net');
            expect(store.getChatHistory(PHONE_JID)).toEqual([]);
            // The number is free again for a new link.
            expect(store.linkLid(PHONE_JID, '100000000000003@lid')).toBe(true);
            expect(store.resolveIdentity(PHONE_JID).allJids).toEqual([PHONE_JID, '100000000000003@lid']);
        });

        test('WHATSAPP_LID_ALT=0 makes the resolver ignore saved links', () => {
            store.linkLid(PHONE_JID, LID);
            process.env.WHATSAPP_LID_ALT = '0';

            expect(store.resolveIdentity(LID).phoneJid).toBeNull();
            expect(store.resolveIdentity('5490000000001').allJids).toEqual([PHONE_JID]);
        });

        test('history by number finds the messages filed under the WhatsApp ID', async () => {
            ev.emit('messages.upsert', {
                messages: [{ key: { remoteJid: LID, id: 'msg1', fromMe: false }, messageTimestamp: 1000, message: { conversation: 'Reminder' } }],
                type: 'notify'
            });
            await new Promise(r => setTimeout(r, 600));

            store.linkLid(PHONE_JID, LID);

            const history = store.getChatHistory('5490000000001');
            expect(history.map(m => m.message.conversation)).toEqual(['Reminder']);
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
