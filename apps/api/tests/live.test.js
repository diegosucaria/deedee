const request = require('supertest');
const express = require('express');
const axios = require('axios');
const { authMiddleware } = require('../src/auth');

// Mock Auth Middleware to allow tests to pass
jest.mock('../src/auth', () => ({
    authMiddleware: (req, res, next) => next()
}));

// Mock Axios
jest.mock('axios');

const liveRouter = require('../src/live');

describe('API Live Router', () => {
    let app;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use('/live', liveRouter);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('GET /live/config should proxy to Agent', async () => {
        // Mock Agent Response
        axios.get.mockResolvedValue({
            data: { model: 'mock-model' }
        });

        const res = await request(app).get('/live/config');

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ model: 'mock-model' });
        expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/live/config'));
    });

    test('POST /live/tools/execute passes the call\'s id and what it read to the Agent', async () => {
        // The agent cannot see either: which call this is, and whether its
        // model read the web through Google's own search.
        axios.post.mockResolvedValue({ data: { result: { ok: true } } });
        const res = await request(app).post('/live/tools/execute').send({ name: 'getFact', args: { key: 'x' }, sessionId: 'call-0001-aaaa', readWeb: true });
        expect(res.statusCode).toBe(200);
        expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/tools/execute'), { name: 'getFact', args: { key: 'x' }, sessionId: 'call-0001-aaaa', readWeb: true });

        // Anything else in those fields is dropped, not forwarded.
        await request(app).post('/live/tools/execute').send({ name: 'getFact', args: {}, sessionId: { $ne: 1 }, readWeb: 'yes' });
        expect(axios.post).toHaveBeenLastCalledWith(expect.any(String), { name: 'getFact', args: {}, sessionId: null, readWeb: false });
    });

    test('POST /live/token should proxy to Agent and pass model and expiry through', async () => {
        const data = { token: 'auth_tokens/mock-token', model: 'models/mock-live', expiresAt: '2026-01-01T00:30:00.000Z' };
        axios.post.mockResolvedValue({ data });

        const res = await request(app).post('/live/token');

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(data);
        expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/live/token'));
    });

    test('GET /live/config passes voice and systemInstruction through', async () => {
        const data = { model: 'models/mock-live', voice: 'Puck', systemInstruction: 'You are Deedee.' };
        axios.get.mockResolvedValue({ data });

        const res = await request(app).get('/live/config');

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(data);
    });
});
