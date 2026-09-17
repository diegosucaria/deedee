const request = require('supertest');
const express = require('express');
const axios = require('axios');

jest.mock('axios');

const guardianRouter = require('../src/routes/guardian');

describe('API /v1/guardian proxy', () => {
    let app;
    let err;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use('/v1/guardian', guardianRouter);
        err = jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => { jest.clearAllMocks(); err.mockRestore(); });

    test('each route reaches the matching agent route with the query and body', async () => {
        axios.mockResolvedValue({ data: { ok: true } });
        const cases = [
            ['get', '/v1/guardian/history?outcome=auto_denied', 'GET', '/internal/guardian/history'],
            ['get', '/v1/guardian/history/abc', 'GET', '/internal/guardian/history/abc'],
            ['get', '/v1/guardian/stats?from=2026-09-01', 'GET', '/internal/guardian/stats'],
            ['get', '/v1/guardian/policy', 'GET', '/internal/guardian/policy'],
            ['put', '/v1/guardian/policy', 'PUT', '/internal/guardian/policy'],
            ['post', '/v1/guardian/dry-run', 'POST', '/internal/guardian/dry-run'],
            ['post', '/v1/guardian/feedback/abc', 'POST', '/internal/guardian/feedback/abc'],
        ];
        for (const [verb, url, method, target] of cases) {
            axios.mockClear();
            const res = await request(app)[verb](url).send(verb === 'get' ? undefined : { mode: 'manual' });
            expect(res.statusCode).toBe(200);
            const cfg = axios.mock.calls[0][0];
            expect(cfg.method).toBe(method);
            expect(cfg.url.endsWith(target)).toBe(true);
            if (verb !== 'get') expect(cfg.data).toEqual({ mode: 'manual' });
        }
        axios.mockClear();
        await request(app).get('/v1/guardian/history?outcome=auto_denied');
        expect(axios.mock.calls[0][0].params).toEqual({ outcome: 'auto_denied' });
    });

    test('agent errors pass through; an unreachable agent is 502', async () => {
        axios.mockRejectedValueOnce({ message: 'bad', response: { status: 400, data: { error: 'mode must be manual, smart or off' } } });
        const bad = await request(app).put('/v1/guardian/policy').send({ mode: 'x' });
        expect(bad.statusCode).toBe(400);
        axios.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        expect((await request(app).get('/v1/guardian/stats')).statusCode).toBe(502);
    });
});
