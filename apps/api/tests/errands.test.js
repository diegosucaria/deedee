const request = require('supertest');
const express = require('express');
const axios = require('axios');

jest.mock('axios');

const autopilotRouter = require('../src/routes/autopilot');

// The route module reads AGENT_URL once, at load.
const AGENT = process.env.AGENT_URL || 'http://agent:3000';

// Autopilot → Errands: the gateway passes three routes on to the agent's
// /v1/autopilot/errands routes. The agent's internal token is added by the
// axios interceptor in server.js, so it is not part of these calls.
describe('API /v1/autopilot/errands proxy', () => {
    let app;
    let err;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use('/v1/autopilot', autopilotRouter);
        err = jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => { jest.clearAllMocks(); err.mockRestore(); });

    test('the list reaches the agent with ?all=1 and returns its answer as is', async () => {
        const body = { enabled: true, limits: { openErrands: 3 }, errands: [{ id: 1, goal: 'book', state: 'waiting_contact', contactName: 'Alice' }] };
        axios.mockResolvedValue({ data: body });
        const res = await request(app).get('/v1/autopilot/errands?all=1');
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(body);
        const cfg = axios.mock.calls[0][0];
        expect(cfg.method).toBe('GET');
        expect(cfg.url).toBe(`${AGENT}/v1/autopilot/errands`);
        expect(cfg.params).toEqual({ all: '1' });
        expect(cfg.data).toBeNull();
    });

    test('one errand and its cancel reach the matching agent routes', async () => {
        axios.mockResolvedValue({ data: { success: true } });
        const cases = [
            ['get', '/v1/autopilot/errands/7', 'GET', '/v1/autopilot/errands/7'],
            ['post', '/v1/autopilot/errands/7/cancel', 'POST', '/v1/autopilot/errands/7/cancel'],
        ];
        for (const [verb, url, method, target] of cases) {
            axios.mockClear();
            const res = await request(app)[verb](url);
            expect(res.statusCode).toBe(200);
            const cfg = axios.mock.calls[0][0];
            expect(cfg.method).toBe(method);
            expect(cfg.url).toBe(`${AGENT}${target}`);
        }
    });

    test('cancel forwards no body, whatever the caller posts', async () => {
        axios.mockResolvedValue({ data: { success: true, info: 'Errand #7 with Alice is cancelled. Nothing was sent.' } });
        await request(app).post('/v1/autopilot/errands/7/cancel').send({ action: 'accept', date: '2026-10-08', time: '10:00' });
        expect(axios.mock.calls[0][0].data).toBeNull();
    });

    test('an id cannot reach another agent route: it is encoded', async () => {
        axios.mockResolvedValue({ data: {} });
        await request(app).get('/v1/autopilot/errands/..%2Fsettings');
        expect(axios.mock.calls[0][0].url).toBe(`${AGENT}/v1/autopilot/errands/..%2Fsettings`);
        axios.mockClear();
        await request(app).post('/v1/autopilot/errands/7%3Fx%3D1/cancel');
        expect(axios.mock.calls[0][0].url).toBe(`${AGENT}/v1/autopilot/errands/7%3Fx%3D1/cancel`);
    });

    test('agent errors pass through with their status and body', async () => {
        axios.mockRejectedValueOnce({ message: 'conflict', response: { status: 409, data: { error: 'Errand #7 is already done.' } } });
        const conflict = await request(app).post('/v1/autopilot/errands/7/cancel');
        expect(conflict.statusCode).toBe(409);
        expect(conflict.body).toEqual({ error: 'Errand #7 is already done.' });

        axios.mockRejectedValueOnce({ message: 'not found', response: { status: 404, data: { error: 'Errand not found' } } });
        const missing = await request(app).get('/v1/autopilot/errands/99');
        expect(missing.statusCode).toBe(404);
        expect(missing.body).toEqual({ error: 'Errand not found' });
    });

    test('an unreachable agent is 502', async () => {
        axios.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const res = await request(app).get('/v1/autopilot/errands');
        expect(res.statusCode).toBe(502);
        expect(res.body).toEqual({ error: 'Agent Service unavailable' });
    });
});

describe('API /v1/autopilot/errands auth', () => {
    const TOKEN = 'test-token-errands';
    let app;
    let saved;

    beforeAll(() => {
        // server.js warns at load about settings these tests do not need.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { });
        ({ app } = require('../src/server'));
        warn.mockRestore();
        saved = process.env.DEEDEE_API_TOKEN;
        process.env.DEEDEE_API_TOKEN = TOKEN;
    });

    afterAll(() => {
        if (saved === undefined) delete process.env.DEEDEE_API_TOKEN;
        else process.env.DEEDEE_API_TOKEN = saved;
    });

    afterEach(() => { jest.clearAllMocks(); });

    test('every errand route needs the bearer token and never reaches the agent without it', async () => {
        const calls = [
            () => request(app).get('/v1/autopilot/errands?all=1'),
            () => request(app).get('/v1/autopilot/errands/7'),
            () => request(app).post('/v1/autopilot/errands/7/cancel'),
        ];
        for (const call of calls) {
            expect((await call()).statusCode).toBe(401);
            expect((await call().set('Authorization', 'Bearer wrong-token')).statusCode).toBe(403);
        }
        expect(axios).not.toHaveBeenCalled();

        axios.mockResolvedValue({ data: { enabled: true, errands: [] } });
        const ok = await request(app).get('/v1/autopilot/errands').set('Authorization', `Bearer ${TOKEN}`);
        expect(ok.statusCode).toBe(200);
        expect(axios).toHaveBeenCalledTimes(1);
    });
});
