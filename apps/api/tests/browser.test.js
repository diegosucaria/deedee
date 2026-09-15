const request = require('supertest');
const express = require('express');
const axios = require('axios');

jest.mock('axios');

const browserRouter = require('../src/routes/browser');

describe('API /v1/browser proxy', () => {
    let app;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use('/v1/browser', browserRouter);
    });

    afterEach(() => jest.clearAllMocks());

    test('GET /status proxies the agent status', async () => {
        axios.get.mockResolvedValue({ data: { running: true, url: 'about:blank', agentBusy: false, watchers: 0 } });
        const res = await request(app).get('/v1/browser/status');
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ running: true, url: 'about:blank', agentBusy: false, watchers: 0 });
        expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/internal/browser/live/status'));
    });

    test('POST /start proxies to the agent and passes its error status through', async () => {
        axios.post.mockResolvedValue({ data: { running: true } });
        const ok = await request(app).post('/v1/browser/start');
        expect(ok.statusCode).toBe(200);
        expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/internal/browser/live/start'), {});

        axios.post.mockRejectedValue({ response: { status: 409, data: { error: 'browser down' } } });
        const bad = await request(app).post('/v1/browser/start');
        expect(bad.statusCode).toBe(409);
        expect(bad.body).toEqual({ error: 'browser down' });
    });
});
