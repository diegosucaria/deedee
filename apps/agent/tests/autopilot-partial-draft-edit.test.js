/**
 * A draft that went out in part resumes from sent_count over the same split
 * when the owner approves it. An edit would send the wrong parts, or none
 * (the owner deletes the part that went out, approves, and the web says
 * sent while the contact gets nothing). Such a draft cannot be edited.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { AgentDB } = require('../src/db');
const { createAutopilotRouter } = require('../src/routes/autopilot');

describe('PUT /drafts/:id on a partly sent draft', () => {
    let dir, db, app;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-draft-edit-'));
        db = new AgentDB(dir);
        db.init();
        app = express();
        app.use(express.json());
        app.use('/', createAutopilotRouter({ db, interface: { send: jest.fn().mockResolvedValue(true) } }));
    });
    afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

    const insert = (status, sentCount = 0) => db.db.prepare("INSERT INTO autopilot_drafts (chat_id, contact_id, content, status, sent_count) VALUES ('c1', 'p1', 'Hola [SPLIT] Nos vemos', ?, ?)").run(status, sentCount).lastInsertRowid;
    const contentOf = (id) => db.db.prepare('SELECT content FROM autopilot_drafts WHERE id = ?').get(id).content;

    test('is refused with a plain reason, and the text stays as it was', async () => {
        const id = insert('partially_sent', 1);
        const res = await request(app).put(`/drafts/${id}`).send({ content: 'Nos vemos' });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/already went out/);
        expect(contentOf(id)).toBe('Hola [SPLIT] Nos vemos');
    });

    test('a pending draft can still be edited', async () => {
        const id = insert('pending');
        const res = await request(app).put(`/drafts/${id}`).send({ content: 'Hola, nos vemos' });
        expect(res.statusCode).toBe(200);
        expect(contentOf(id)).toBe('Hola, nos vemos');
    });
});
