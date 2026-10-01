/**
 * What errands need from the WhatsApp service: history rows that say which
 * message is whose (id, fromMe), and the owner's style as numbers only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WhatsAppService, SQLiteStore } = require('../src/whatsapp');

jest.mock('axios');

describe('errand support in the WhatsApp service', () => {
    let dir, store, wa;

    const insert = (keyId, jid, fromMe, ts, text) => store.db.prepare(
        'INSERT INTO messages (key_id, remote_jid, from_me, timestamp, content, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(keyId, jid, fromMe ? 1 : 0, ts, text, JSON.stringify({ key: { remoteJid: jid, id: keyId, fromMe }, messageTimestamp: ts, message: { conversation: text } }));

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errand-wa-'));
        store = new SQLiteStore(path.join(dir, 'm.db'));
        wa = new WhatsAppService('http://agent', 'user');
        wa.store = store;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (store?.queueFlushInterval) clearInterval(store.queueFlushInterval);
        for (const t of [wa?.heartbeatTimer, wa?.presenceInterval]) if (t) clearInterval(t);
        for (const t of [wa?.reconnectTimeout, wa?.sleepTimeout]) if (t) clearTimeout(t);
        if (store?.db?.open) store.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('history rows carry the WhatsApp id and who wrote them, so an errand can tell its own messages', () => {
        insert('K1', '15550100@s.whatsapp.net', false, 1000, 'hola');
        insert('K2', '15550100@s.whatsapp.net', true, 1001, 'dale');
        const rows = wa.getChatHistory('15550100@s.whatsapp.net', 10);
        expect(rows).toEqual([
            { role: 'user', content: 'hola', timestamp: 1000000, id: 'K1', fromMe: false },
            { role: 'assistant', content: 'dale', timestamp: 1001000, id: 'K2', fromMe: true }
        ]);
    });

    test('a file sent from a phone is labelled by its own kind, not by the context key WhatsApp puts first', () => {
        const jid = '15550100@s.whatsapp.net';
        store.db.prepare('INSERT INTO messages (key_id, remote_jid, from_me, timestamp, content, data) VALUES (?, ?, ?, ?, ?, ?)').run('F1', jid, 0, 3000, '',
            JSON.stringify({ key: { remoteJid: jid, id: 'F1', fromMe: false }, messageTimestamp: 3000, message: { messageContextInfo: { deviceListMetadata: {} }, documentWithCaptionMessage: { message: { documentMessage: { caption: 'lista' } } } } }));
        expect(wa.getChatHistory(jid, 10)[0].content).toBe('[Media: documentWithCaptionMessage]');
    });

    test('a message in a chat with disappearing messages reads as what it wraps', () => {
        const jid = '15550100@s.whatsapp.net';
        store.db.prepare('INSERT INTO messages (key_id, remote_jid, from_me, timestamp, content, data) VALUES (?, ?, ?, ?, ?, ?)').run('E1', jid, 0, 4000, '',
            JSON.stringify({ key: { remoteJid: jid, id: 'E1', fromMe: false }, messageTimestamp: 4000, message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'dale, jueves 10' } } } } }));
        store.db.prepare('INSERT INTO messages (key_id, remote_jid, from_me, timestamp, content, data) VALUES (?, ?, ?, ?, ?, ?)').run('E2', jid, 0, 4001, '',
            JSON.stringify({ key: { remoteJid: jid, id: 'E2', fromMe: false }, messageTimestamp: 4001, message: { ephemeralMessage: { message: { documentMessage: { fileName: 'x.pdf' } } } } }));
        const rows = wa.getChatHistory(jid, 10);
        expect(rows.map(r => r.content)).toEqual(['dale, jueves 10', '[Media: documentMessage]']);
    });

    // Errands read with exact: true (GET /whatsapp/history?exact=1). The old
    // last-digits guess read another person's chat as the contact's, and an
    // errand thanked and booked on that person's "dale".
    describe('exact mode reads only the same person', () => {
        const ALICE = '5490000000002@s.whatsapp.net';
        const ALICE_LID = '100000000000091@lid';
        const CAROL = '5490000000003@s.whatsapp.net';
        // A number he never wrote to that shares only Carol's last digits.
        const NEW_NUMBER = '5493000000003@s.whatsapp.net';
        const contact = (id, name, lid = null) => store.db.prepare('INSERT INTO contacts (id, name, notify, lid, data) VALUES (?, ?, ?, ?, ?)')
            .run(id, name, null, lid, JSON.stringify({ id, name, lid }));

        test('a new number never reads the chat of a contact whose last 7 digits match', () => {
            contact(CAROL, 'Carol');
            insert('C1', CAROL, true, 1000, 'hola');
            insert('C2', CAROL, false, 1001, 'dale!');
            // Other callers keep the guess.
            expect(wa.getChatHistory(NEW_NUMBER, 10).map(m => m.id)).toEqual(['C1', 'C2']);
            for (const jid of [NEW_NUMBER, '5493000000003']) {
                expect(wa.getChatHistory(jid, 10, { exact: true })).toEqual([]);
            }
        });

        // The agent takes two numbers that end in the same 10 digits for one
        // line, so the guess swapped in a number from another country.
        test('a number never resolves to a contact in another country that shares its last digits', () => {
            const BOB = '13000000003@s.whatsapp.net';
            contact(BOB, 'Bob');
            expect(wa.resolveIdentity(NEW_NUMBER).phoneJid).toBe(BOB);
            for (const input of [NEW_NUMBER, '5493000000003', '+54 9 300 000-0003']) {
                expect(wa.resolveIdentity(input, { exact: true })).toEqual({ phoneJid: NEW_NUMBER, lid: null, name: null, allJids: [NEW_NUMBER] });
            }
        });

        test('exact still reads her chat under her number and under the WhatsApp ID contacts give her, both ways', () => {
            contact(ALICE, 'Alice', ALICE_LID);
            insert('A1', ALICE, true, 1000, 'hola');
            insert('A2', ALICE_LID, false, 1001, 'dale');
            for (const jid of [ALICE, ALICE_LID, '5490000000002']) {
                expect(wa.getChatHistory(jid, 10, { exact: true }).map(m => m.id)).toEqual(['A1', 'A2']);
            }
            expect(wa.resolveIdentity(ALICE_LID, { exact: true })).toEqual({ phoneJid: ALICE, lid: ALICE_LID, name: 'Alice', allJids: [ALICE, ALICE_LID] });
        });

        test('exact still follows a link saved from a message key, both ways', () => {
            store.linkLid(ALICE, ALICE_LID);
            insert('A1', ALICE_LID, false, 1000, 'dale');
            expect(wa.getChatHistory(ALICE, 10, { exact: true }).map(m => m.id)).toEqual(['A1']);
            expect(wa.resolveIdentity(ALICE_LID, { exact: true }).phoneJid).toBe(ALICE);
        });

        test('a WhatsApp ID the store never saw comes back with no lid; one it saw keeps it', () => {
            expect(wa.resolveIdentity(ALICE_LID, { exact: true })).toEqual({ phoneJid: null, lid: null, name: null, allJids: [ALICE_LID] });
            insert('A1', ALICE_LID, false, 1000, 'dale');
            expect(wa.resolveIdentity(ALICE_LID, { exact: true })).toEqual({ phoneJid: null, lid: ALICE_LID, name: null, allJids: [ALICE_LID] });
            expect(wa.getChatHistory(ALICE_LID, 10, { exact: true }).map(m => m.id)).toEqual(['A1']);
        });

        // A send to "<ID digits>@s.whatsapp.net" goes to that phone number,
        // not to the WhatsApp ID, so the ID's chat is someone else's.
        test('a phone address made of WhatsApp ID digits never reads that ID\'s chat', () => {
            insert('A1', ALICE_LID, false, 1000, 'dale');
            const asPhone = '100000000000091@s.whatsapp.net';
            expect(wa.getChatHistory(asPhone, 10).map(m => m.id)).toEqual(['A1']);
            expect(wa.getChatHistory(asPhone, 10, { exact: true })).toEqual([]);
            // Bare digits may still name the ID.
            expect(wa.resolveIdentity('100000000000091', { exact: true }).lid).toBe(ALICE_LID);
        });

        test('a group or a name never reads anyone else\'s chat', () => {
            contact(CAROL, 'Carol');
            insert('C1', CAROL, false, 1000, 'dale');
            for (const jid of ['100000000000000003@g.us', 'Carol', '0000003']) {
                expect(wa.getChatHistory(jid, 10, { exact: true })).toEqual([]);
                expect(wa.resolveIdentity(jid, { exact: true }).lid).toBeNull();
            }
        });
    });

    test('style numbers come from his own one-to-one texts only, and hold no text', () => {
        for (let i = 0; i < 30; i++) insert(`O${i}`, '15550100@s.whatsapp.net', true, 2000 + i * 200, i % 3 === 0 ? 'tenes turno el jueves?' : 'dale');
        insert('G1', '120000000000001@g.us', true, 9000, '¿Esto es un grupo?');
        insert('T1', '15550100@s.whatsapp.net', false, 9001, '¿Te sirve?');
        const stats = wa.getOwnStyleStats();
        expect(stats.n).toBe(30);
        expect(stats.questions).toBe(10);
        expect(stats.openQuestion).toBe(0);
        expect(JSON.stringify(stats)).not.toMatch(/dale|jueves|grupo/);
    });
});
