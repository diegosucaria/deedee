/**
 * /internal/notifications/outbox: recent ledger rows with counts, and the
 * Retry button endpoint.
 */
const request = require('supertest');
const express = require('express');
const { createNotificationsRouter } = require('../src/routes/notifications');

describe('Notifications router - delivery outbox', () => {
    let app;
    let agent;

    beforeEach(() => {
        agent = {
            db: {},
            delivery: {
                listRecent: jest.fn().mockReturnValue([{ id: 'r1', kind: 'reminder', channel: 'whatsapp', status: 'failed', payload: { content: 'x' } }]),
                counts: jest.fn().mockReturnValue({ pending: 0, sent: 3, failed: 1, dead: 0 }),
                retryNow: jest.fn()
            }
        };
        app = express();
        app.use(express.json());
        app.use('/internal/notifications', createNotificationsRouter(agent));
    });

    test('GET /outbox returns rows and counts with the default limit', async () => {
        const res = await request(app).get('/internal/notifications/outbox');
        expect(res.status).toBe(200);
        expect(res.body.counts).toEqual({ pending: 0, sent: 3, failed: 1, dead: 0 });
        expect(res.body.rows).toHaveLength(1);
        expect(agent.delivery.listRecent).toHaveBeenCalledWith(50, null);
    });

    test('GET /outbox passes a limit and a valid status filter; unknown statuses are ignored', async () => {
        await request(app).get('/internal/notifications/outbox?limit=5&status=dead');
        expect(agent.delivery.listRecent).toHaveBeenLastCalledWith(5, 'dead');
        await request(app).get('/internal/notifications/outbox?status=bogus');
        expect(agent.delivery.listRecent).toHaveBeenLastCalledWith(50, null);
    });

    test('POST /outbox/:id/retry reports the attempt', async () => {
        agent.delivery.retryNow.mockResolvedValue({ delivered: true, status: 'sent', via: 'telegram', row: { id: 'r1', status: 'sent' } });
        const res = await request(app).post('/internal/notifications/outbox/r1/retry');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, delivered: true, status: 'sent', via: 'telegram', row: { id: 'r1', status: 'sent' } });
        expect(agent.delivery.retryNow).toHaveBeenCalledWith('r1');
    });

    test('POST /outbox/:id/retry answers 404 for unknown or already sent rows', async () => {
        agent.delivery.retryNow.mockResolvedValue(null);
        const res = await request(app).post('/internal/notifications/outbox/missing/retry');
        expect(res.status).toBe(404);
    });

    test('errors from the ledger become a 500 with the message', async () => {
        agent.delivery.listRecent.mockImplementation(() => { throw new Error('db locked'); });
        const res = await request(app).get('/internal/notifications/outbox');
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'db locked' });
    });

    test('the old notification routes still work next to the outbox ones', async () => {
        agent.db.markNotificationRead = jest.fn();
        const res = await request(app).post('/internal/notifications/n1/read');
        expect(res.status).toBe(200);
        expect(agent.db.markNotificationRead).toHaveBeenCalledWith('n1');
    });
});
