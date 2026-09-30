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
