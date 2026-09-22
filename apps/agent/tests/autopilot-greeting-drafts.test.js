// Review-mode greeting drafts live in autopilot_drafts with an expiry. A
// good-morning draft approved in the evening must not go out, and a greeting
// draft must never be taken for the chat's pending autopilot reply (that
// would feed the owner's next message into style learning).
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { AgentDB } = require('../src/db');
const { createAutopilotRouter, expireDrafts } = require('../src/routes/autopilot');
const { ImpersonationService } = require('../src/services/impersonation');

const CHAT = '100000000000001@lid';

describe('Greeting drafts in Autopilot', () => {
    let dir;
    let db;
    let send;
    let app;

    const draft = (expiresAt, content = 'Good morning love') => db.createAutopilotDraft({
        chatId: CHAT, contactId: CHAT, content, contextContent: 'Daily good morning greeting',
        options: { kind: 'morning', name: 'Alex' }, source: 'partner_greeting', expiresAt
    });

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greeting-drafts-'));
        db = new AgentDB(dir);
        send = jest.fn().mockResolvedValue({});
        app = express();
        app.use(express.json());
        app.use('/', createAutopilotRouter({ db, interface: { send } }));
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('createAutopilotDraft stores the source and the expiry', () => {
        const id = draft('2030-01-01T00:00:00.000Z');
        const row = db.db.prepare('SELECT * FROM autopilot_drafts WHERE id = ?').get(id);
        expect(row).toMatchObject({ chat_id: CHAT, status: 'pending', source: 'partner_greeting', expires_at: '2030-01-01T00:00:00.000Z' });
        expect(JSON.parse(row.options)).toEqual({ kind: 'morning', name: 'Alex' });
    });

    test('an expired greeting draft cannot be approved and nothing is sent', async () => {
        const id = draft(new Date(Date.now() - 60_000).toISOString());
        const res = await request(app).post(`/drafts/${id}/approve`);
        expect(res.status).toBe(410);
        expect(send).not.toHaveBeenCalled();
        expect(db.db.prepare('SELECT status FROM autopilot_drafts WHERE id = ?').get(id).status).toBe('expired');
    });

    test('the Drafts list hides expired drafts and keeps live ones', async () => {
        const stale = draft(new Date(Date.now() - 60_000).toISOString(), 'stale');
        const live = draft(new Date(Date.now() + 3_600_000).toISOString(), 'live');
        const res = await request(app).get('/drafts');
        expect(res.status).toBe(200);
        expect(res.body.map(d => d.id)).toEqual([live]);
        expect(res.body[0].source).toBe('partner_greeting');
        expect(db.db.prepare('SELECT status FROM autopilot_drafts WHERE id = ?').get(stale).status).toBe('expired');
        expect(expireDrafts(db)).toBe(0);
    });

    test('approving a live greeting draft sends it from the owner\'s session', async () => {
        const id = draft(new Date(Date.now() + 3_600_000).toISOString());
        const res = await request(app).post(`/drafts/${id}/approve`);
        expect(res.status).toBe(200);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: 'Good morning love', metadata: { chatId: CHAT, session: 'user' } }));
    });

    test('a greeting draft is never the chat\'s pending autopilot draft', () => {
        draft(new Date(Date.now() + 3_600_000).toISOString());
        const impersonation = new ImpersonationService({ db });
        expect(impersonation.getPendingDraft(CHAT)).toBeUndefined();
        impersonation.saveDraft(CHAT, CHAT, 'a real reply draft');
        expect(impersonation.getPendingDraft(CHAT).content).toBe('a real reply draft');
    });
});
