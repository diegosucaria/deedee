// The Autopilot contact list sorts by the last WhatsApp message. It read
// chat.remote_jid (seconds) while /whatsapp/recent returns jid and
// lastTimestamp in milliseconds, so every contact sorted as never messaged.
jest.mock('axios');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { AgentDB } = require('../src/db');
const { createAutopilotRouter } = require('../src/routes/autopilot');
const { SQLiteStore } = require('../../interfaces/src/whatsapp');

describe('Autopilot settings sort by the latest WhatsApp message', () => {
    let dir;
    let db;
    let app;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-recency-'));
        db = new AgentDB(dir);
        app = express();
        app.use(express.json());
        app.use('/', createAutopilotRouter({ db }));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('recent chats by phone JID and by linked WhatsApp ID set last_message_at in ms', async () => {
        db.createPerson({ name: 'Alex', phone: '5490000000001' });
        db.createPerson({ name: 'Bea', phone: '5490000000002', identifiers: { whatsapp: '5490000000002', whatsapp_lid: '100000000000002' } });
        db.createPerson({ name: 'Cleo', phone: '5490000000003' });
        axios.get.mockResolvedValue({ data: [
            { jid: '5490000000001@s.whatsapp.net', lastTimestamp: 1_800_000_000_000 },
            { jid: '100000000000002@lid', lastTimestamp: 1_800_000_500_000 }
        ] });

        const res = await request(app).get('/settings');
        expect(res.status).toBe(200);
        expect(res.body.map(p => p.name)).toEqual(['Bea', 'Alex', 'Cleo']);
        expect(res.body[0].last_message_at).toBe(1_800_000_500_000);
        expect(res.body[2].last_message_at).toBe(0);
        expect(res.body[0].identifiers).toBeUndefined();
    });

    test('each row carries the WhatsApp ID, so the Style picker never offers a linked contact as new', async () => {
        db.createPerson({ name: 'Alex', phone: '5490000000001' });
        db.createPerson({ name: 'Bea', phone: '5490000000002', identifiers: { whatsapp: '5490000000002', whatsapp_lid: '100000000000002' } });
        axios.get.mockResolvedValue({ data: [] });

        const res = await request(app).get('/settings');
        const byName = Object.fromEntries(res.body.map(p => [p.name, p]));
        expect(byName.Bea.whatsapp_lid).toBe('100000000000002');
        expect(byName.Alex.whatsapp_lid).toBeNull();
    });

    test('the sort reads what the real store returns for /whatsapp/recent', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const store = new SQLiteStore(path.join(dir, 'messages_user.db'));
        try {
            // Alex's chat is filed under his WhatsApp ID; the store reports it
            // under his phone JID. Cleo's WhatsApp ID has no contact row.
            await store.upsertContacts([
                { id: '5490000000001@s.whatsapp.net', name: 'Alex', notify: null, lid: '100000000000091@lid' }
            ]);
            const insert = store.db.prepare('INSERT INTO messages (key_id, remote_jid, from_me, timestamp, content, data) VALUES (?, ?, ?, ?, ?, ?)');
            insert.run('k1', '100000000000091@lid', 0, 1_800_000_000, 'see you at the station', '{}');
            insert.run('k2', '100000000000099@lid', 0, 1_800_000_900, 'running late, sorry', '{}');

            db.createPerson({ name: 'Alex', phone: '5490000000001' });
            db.createPerson({ name: 'Bea', phone: '5490000000002' });
            db.createPerson({ name: 'Cleo', phone: '5490000000003', identifiers: { whatsapp: '5490000000003', whatsapp_lid: '100000000000099' } });
            axios.get.mockResolvedValue({ data: store.getRecentChats(200) });

            const res = await request(app).get('/settings');
            expect(res.body.map(p => [p.name, p.last_message_at])).toEqual([
                ['Cleo', 1_800_000_900_000],
                ['Alex', 1_800_000_000_000],
                ['Bea', 0]
            ]);
        } finally {
            clearInterval(store.queueFlushInterval);
            store.close();
        }
    });
});
