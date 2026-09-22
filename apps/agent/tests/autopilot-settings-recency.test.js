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
});
