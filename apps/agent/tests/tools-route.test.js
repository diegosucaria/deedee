/**
 * POST /tools/execute is how the live voice session runs a tool. It used to
 * call the executor straight, so the deny-list, the safety rules, the
 * always-ask floor and the guardian never saw those calls. It goes through
 * the same gate as a chat now.
 */
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createToolRouter } = require('../src/routes/tools');
const { AgentDB } = require('../src/db');
const { ApprovalService } = require('../src/services/approval-service');
const { GuardianService } = require('../src/services/guardian-service');
const { DeliveryService } = require('../src/services/delivery-service');

const OWNER_DIGITS = '10000000000';
const verdictOf = (v) => ({ text: JSON.stringify(v), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });

describe('POST /tools/execute', () => {
    let dir, db, agent, app, spies, generateContent;

    beforeEach(() => {
        delete process.env.APPROVALS_DENY;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-tools-route-'));
        db = new AgentDB(dir);
        generateContent = jest.fn().mockResolvedValue(verdictOf({ verdict: 'escalate', reason: 'unsure', risk: 'medium' }));
        agent = {
            db,
            settings: { owner_phone: `+${OWNER_DIGITS}`, notification_channel: 'whatsapp' },
            interface: { send: jest.fn().mockResolvedValue(true), broadcast: jest.fn().mockResolvedValue(true) },
            notifications: { create: jest.fn() },
            client: { models: { generateContent } },
            mcp: { getTools: jest.fn().mockResolvedValue([]), getStatus: jest.fn().mockResolvedValue([]), toolMap: new Map() },
            toolExecutor: { execute: jest.fn().mockResolvedValue({ success: true }) },
            _executeTool: jest.fn().mockResolvedValue({ success: true }),
            _getOwnerWaIds: jest.fn().mockResolvedValue(new Set()),
        };
        agent.delivery = new DeliveryService(agent);
        agent.approvals = new ApprovalService(agent, { guardian: new GuardianService(agent, { timeoutMs: 50 }) });
        app = express();
        app.use(express.json());
        app.use('/', createToolRouter(agent));
        spies = ['warn', 'log', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        agent.approvals?.stop();
        spies.forEach(s => s.mockRestore());
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('an everyday tool runs', async () => {
        const res = await request(app).post('/tools/execute').send({ name: 'getFact', args: { key: 'coffee' } });
        expect(res.status).toBe(200);
        expect(res.body.result).toEqual({ success: true });
        expect(agent.toolExecutor.execute).toHaveBeenCalledWith('getFact', { key: 'coffee' }, expect.any(Object));
    });

    test('a call on the floor never runs: the owner gets the card, the caller gets the pause', async () => {
        const res = await request(app).post('/tools/execute').send({ name: 'commitAndPush', args: { message: 'feat: x' } });
        expect(res.status).toBe(200);
        expect(res.body.gated).toBe(true);
        expect(res.body.status).toBe('paused');
        expect(res.body.result.info).toMatch(/Action PAUSED/);
        expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
        const [row] = db.listPendingConfirmations();
        expect(row).toMatchObject({ tool_name: 'commitAndPush', status: 'pending', mode: 'deferred' });
        // A live session is not a chat he can answer in, so the card goes to his channel.
        expect(row.reply_chat_id).toBe(`${OWNER_DIGITS}@s.whatsapp.net`);
    });

    test('the deny-list blocks the call with no card', async () => {
        process.env.APPROVALS_DENY = 'deleteVault';
        try {
            const res = await request(app).post('/tools/execute').send({ name: 'deleteVault', args: { id: 'v1' } });
            expect(res.body.gated).toBe(true);
            expect(res.body.result.error).toMatch(/deny-list/);
            expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
            expect(db.listPendingConfirmations()).toHaveLength(0);
        } finally {
            delete process.env.APPROVALS_DENY;
        }
    });

    test('the guardian can refuse a call, and the history keeps every gated one', async () => {
        generateContent.mockResolvedValue(verdictOf({ verdict: 'deny', reason: 'Not something the owner asked for.', risk: 'high' }));
        const res = await request(app).post('/tools/execute').send({ name: 'sendEmail', args: { to: 'someone@example.com' } });
        expect(res.body.gated).toBe(true);
        expect(res.body.result.error).toMatch(/Refused by the approval guardian/);
        expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
        const rows = db.listGuardianDecisions({ limit: 10 }).rows;
        expect(rows.map(r => r.outcome)).toContain('auto_denied');
        expect(rows[0]).toMatchObject({ source_kind: 'chat', tool_name: 'sendEmail' });
    });

    test('with no approvals service the call is refused, never run', async () => {
        agent.approvals = null;
        const res = await request(app).post('/tools/execute').send({ name: 'commitAndPush', args: {} });
        expect(res.status).toBe(503);
        expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
    });
});
