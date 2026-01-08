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

    test('POST /live/token should proxy to Agent', async () => {
        axios.post.mockResolvedValue({
            data: { token: 'mock-token' }
        });

        const res = await request(app).post('/live/token');

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ token: 'mock-token' });
        expect(axios.post).toHaveBeenCalledWith(expect.stringContaining('/live/token'));
    });
});
