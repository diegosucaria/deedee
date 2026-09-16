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
