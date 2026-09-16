const request = require('supertest');
const express = require('express');
const axios = require('axios');

jest.mock('axios');

const dashboardRouter = require('../src/dashboard');

describe('API /v1/notifications/outbox proxy', () => {
    let app;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use('/v1', dashboardRouter);
    });

    afterEach(() => jest.clearAllMocks());

    test('GET /outbox proxies the ledger listing with its query', async () => {
        axios.mockResolvedValue({ data: { rows: [], counts: { pending: 0, sent: 1, failed: 0, dead: 0 } } });
        const res = await request(app).get('/v1/notifications/outbox?limit=5&status=dead');
        expect(res.statusCode).toBe(200);
        expect(res.body.counts.sent).toBe(1);
        expect(axios).toHaveBeenCalledWith(expect.objectContaining({
            method: 'GET',
            url: expect.stringContaining('/internal/notifications/outbox'),
            params: { limit: '5', status: 'dead' }
        }));
    });

    test('POST /outbox/:id/retry proxies to the agent and passes its error status through', async () => {
        axios.mockResolvedValue({ data: { success: true, delivered: true } });
        const ok = await request(app).post('/v1/notifications/outbox/row%201/retry');
        expect(ok.statusCode).toBe(200);
        expect(axios).toHaveBeenCalledWith(expect.objectContaining({
            method: 'POST',
            url: expect.stringContaining('/internal/notifications/outbox/row%201/retry')
        }));

        axios.mockRejectedValue({ response: { status: 404, data: { error: 'Row not found or already sent' } } });
        const bad = await request(app).post('/v1/notifications/outbox/missing/retry');
        expect(bad.statusCode).toBe(404);
        expect(bad.body).toEqual({ error: 'Row not found or already sent' });
    });
});
