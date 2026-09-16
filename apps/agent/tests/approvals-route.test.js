/**
 * /internal/approvals: the settings card reads pending rows and decides them.
 */
const request = require('supertest');
const express = require('express');
const { createApprovalsRouter } = require('../src/routes/approvals');

describe('Approvals router', () => {
    let app;
    let agent;

    beforeEach(() => {
        agent = {
            approvals: {
                db: { getPendingConfirmation: jest.fn().mockReturnValue({ id: 'abc123', status: 'approved' }) },
                list: jest.fn().mockReturnValue({ pending: [{ id: 'abc123' }], recent: [], counts: { pending: 1, approved: 0, denied: 0, expired: 0 }, settings: { ttlInteractiveMin: 30 } }),
                decide: jest.fn()
            }
        };
        app = express();
        app.use(express.json());
        app.use('/internal/approvals', createApprovalsRouter(agent));
    });

    test('GET / returns the view with the default limit', async () => {
        const res = await request(app).get('/internal/approvals');
        expect(res.status).toBe(200);
        expect(res.body.pending).toEqual([{ id: 'abc123' }]);
        expect(agent.approvals.list).toHaveBeenCalledWith({ limit: 50 });
        await request(app).get('/internal/approvals?limit=5');
        expect(agent.approvals.list).toHaveBeenLastCalledWith({ limit: 5 });
    });

    test('POST /:id/approve decides via web and returns the result and the row', async () => {
        agent.approvals.decide.mockResolvedValue({ handled: true, result: { ok: true } });
        const res = await request(app).post('/internal/approvals/abc123/approve');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, id: 'abc123', status: 'approved', result: { ok: true }, row: { id: 'abc123', status: 'approved' } });
        expect(agent.approvals.decide).toHaveBeenCalledWith('abc123', 'approved', { via: 'web' });
    });

    test('POST /:id/deny decides denied', async () => {
        agent.approvals.decide.mockResolvedValue({ handled: true });
        const res = await request(app).post('/internal/approvals/abc123/deny');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('denied');
        expect(agent.approvals.decide).toHaveBeenCalledWith('abc123', 'denied', { via: 'web' });
    });

    test('unknown ids answer 404, already decided rows 409', async () => {
        agent.approvals.decide.mockResolvedValueOnce({ handled: false, error: 'No pending approval with id x.', status: 'missing' });
        expect((await request(app).post('/internal/approvals/x/approve')).status).toBe(404);
        agent.approvals.decide.mockResolvedValueOnce({ handled: false, error: 'already denied', status: 'denied' });
        const res = await request(app).post('/internal/approvals/abc123/approve');
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: 'already denied', status: 'denied' });
    });

    test('errors become a 500; a missing service a 503', async () => {
        agent.approvals.list.mockImplementation(() => { throw new Error('db locked'); });
        expect((await request(app).get('/internal/approvals')).status).toBe(500);
        const bare = express();
        bare.use('/internal/approvals', createApprovalsRouter({}));
        expect((await request(bare).get('/internal/approvals')).status).toBe(503);
    });
});
