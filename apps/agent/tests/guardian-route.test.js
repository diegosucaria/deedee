/**
 * /internal/guardian: history filters, stats, the policy (floor read-only),
 * the dry run (never executes) and feedback. Real SQLite and ApprovalService.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { AgentDB } = require('../src/db');
const { ApprovalService } = require('../src/services/approval-service');
const { GuardianService } = require('../src/services/guardian-service');
const { FLOOR } = require('../src/services/guardian-policy');
const { createGuardianRouter } = require('../src/routes/guardian');

describe('Guardian router', () => {
    let dir, db, agent, app, gen, spies;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-guardian-route-'));
        db = new AgentDB(dir);
        gen = jest.fn().mockResolvedValue({ text: JSON.stringify({ verdict: 'allow', reason: 'fine', risk: 'low' }), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
        agent = {
            db, settings: {}, client: { models: { generateContent: gen } },
            interface: { send: jest.fn(), broadcast: jest.fn().mockResolvedValue(true) },
            notifications: { create: jest.fn() },
            _executeTool: jest.fn()
        };
        agent.approvals = new ApprovalService(agent, { guardian: new GuardianService(agent, { timeoutMs: 50 }) });
        app = express();
        app.use(express.json());
        app.use('/internal/guardian', createGuardianRouter(agent));
        spies = ['warn', 'log', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        spies.forEach(s => s.mockRestore());
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('GET /history filters by outcome, tool, risk, source kind and date range; bad filters are 400', async () => {
        db.recordGuardianDecision({ toolName: 'sendMessage', outcome: 'auto_denied', risk: 'high', sourceKind: 'job', guardianInput: { structured: { tool: 'sendMessage' } } });
        db.recordGuardianDecision({ toolName: 'deletePerson', outcome: 'escalated', risk: 'medium', sourceKind: 'chat' });
        db.recordGuardianDecision({ toolName: 'sendMessage', outcome: 'auto_allowed', risk: 'low', sourceKind: 'chat', createdAt: '2026-01-01T00:00:00.000Z' });

        let res = await request(app).get('/internal/guardian/history?outcome=auto_denied');
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        res = await request(app).get('/internal/guardian/history?tool=send*&sourceKind=chat');
        expect(res.body.rows.map(r => r.outcome)).toEqual(['auto_allowed']);
        res = await request(app).get('/internal/guardian/history?risk=medium,high&from=2026-02-01');
        expect(res.body.total).toBe(2);
        res = await request(app).get('/internal/guardian/history?to=2026-01-31');
        expect(res.body.total).toBe(1);

        const one = (await request(app).get('/internal/guardian/history?outcome=auto_denied')).body.rows[0];
        const detail = await request(app).get(`/internal/guardian/history/${one.id}`);
        expect(detail.body.guardian_input).toEqual({ structured: { tool: 'sendMessage' } });
        expect((await request(app).get('/internal/guardian/history/nope')).status).toBe(404);

        for (const q of ['outcome=maybe', 'risk=extreme', 'sourceKind=robot', 'from=yesterday']) {
            expect((await request(app).get(`/internal/guardian/history?${q}`)).status).toBe(400);
        }
    });

    test('GET /stats returns the aggregate view', async () => {
        db.recordGuardianDecision({ toolName: 'sendMessage', outcome: 'auto_allowed', risk: 'low', latencyMs: 500 });
        const res = await request(app).get('/internal/guardian/stats');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ total: 1, autoDecisions: 1, autoRate: 1, medianLatencyMs: 500 });
        expect(res.body.perDay).toHaveLength(1);
    });

    test('GET/PUT /policy: the floor is returned read-only and cannot be removed', async () => {
        let res = await request(app).get('/internal/guardian/policy');
        expect(res.body).toMatchObject({ mode: 'smart', smart_policy: '', always_ask: [] });
        expect(res.body.floor.map(f => f.id)).toEqual(FLOOR);

        res = await request(app).put('/internal/guardian/policy').send({ mode: 'manual', smart_policy: 'Sister is fine', always_ask: ['category:shell', 'category:money'], floor: [] });
        expect(res.status).toBe(200);
        expect(res.body.always_ask).toEqual(['category:shell']);
        expect(res.body.floor.map(f => f.id)).toEqual(FLOOR);
        expect(db.getAgentSetting('approvals').value.floor).toBeUndefined();

        // Removing everything still leaves the floor in force.
        await request(app).put('/internal/guardian/policy').send({ mode: 'smart', always_ask: [] });
        const out = await agent.approvals.review({ message: { role: 'user', content: 'push it', source: 'web', metadata: { chatId: 'w1' } }, toolName: 'commitAndPush', args: {} });
        expect(out.status).toBe('paused');
        expect(db.listGuardianDecisions().rows[0]).toMatchObject({ outcome: 'escalated', model_verdict: 'allow' });

        expect((await request(app).put('/internal/guardian/policy').send({ mode: 'yolo' })).status).toBe(400);
        expect((await request(app).put('/internal/guardian/policy').send({ smart_policy: 5 })).status).toBe(400);
    });

    test('POST /dry-run judges and never executes or stores', async () => {
        const res = await request(app).post('/internal/guardian/dry-run').send({
            toolName: 'sendMessage', args: '{"to":"a@example.com","service":"telegram","content":"hi"}',
            ownerMessage: 'say hi to A', taintSources: ['email (personal_gmail)'], excerpt: 'hello'
        });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ outcome: 'auto_allowed', executed: false, guardian: { verdict: 'allow' } });
        expect(agent._executeTool).not.toHaveBeenCalled();
        expect(agent.interface.send).not.toHaveBeenCalled();
        expect(db.listGuardianDecisions().total).toBe(0);
        expect(db.listPendingConfirmations()).toHaveLength(0);
        expect((await request(app).post('/internal/guardian/dry-run').send({ args: {} })).status).toBe(400);
        expect((await request(app).post('/internal/guardian/dry-run').send({ toolName: 'x', args: 'not json' })).status).toBe(400);
    });

    test('POST /feedback/:id stores feedback without changing the decision', async () => {
        const row = db.recordGuardianDecision({ toolName: 'sendMessage', outcome: 'auto_denied', risk: 'high' });
        let res = await request(app).post(`/internal/guardian/feedback/${row.id}`).send({ feedback: 'should_allow', note: 'my sister' });
        expect(res.status).toBe(200);
        expect(res.body.row).toMatchObject({ feedback: 'should_allow', feedback_note: 'my sister', outcome: 'auto_denied' });
        expect((await request(app).get('/internal/guardian/policy')).body.feedbackCandidates.map(r => r.id)).toEqual([row.id]);
        res = await request(app).post(`/internal/guardian/feedback/${row.id}`).send({ feedback: null });
        expect(res.body.row.feedback).toBeNull();
        expect((await request(app).post(`/internal/guardian/feedback/${row.id}`).send({ feedback: 'meh' })).status).toBe(400);
        expect((await request(app).post('/internal/guardian/feedback/nope').send({ feedback: 'should_deny' })).status).toBe(404);
    });

    test('503 without the approval service', async () => {
        const bare = express();
        bare.use('/internal/guardian', createGuardianRouter({}));
        expect((await request(bare).get('/internal/guardian/history')).status).toBe(503);
    });
});
