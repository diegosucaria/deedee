const request = require('supertest');
const { app } = require('../src/server');
const axios = require('axios');

jest.mock('axios');

describe('API Security', () => {
    const VALID_TOKEN = 'test-token-123';

    beforeAll(() => {
        process.env.DEEDEE_API_TOKEN = VALID_TOKEN;
        process.env.AGENT_URL = 'http://test-agent';
    });

    test('Health check should be public', async () => {
        const res = await request(app).get('/health');
        expect(res.statusCode).toEqual(200);
        expect(res.body.status).toEqual('ok');
    });

    test('Protected route should fail without Authorization header', async () => {
        const res = await request(app)
            .post('/v1/chat')
            .send({ message: 'hi', chatId: '1' });

        expect(res.statusCode).toEqual(401);
        expect(res.body.error).toContain('Missing or malformed');
    });

    test('Protected route should fail with invalid token', async () => {
        const res = await request(app)
            .post('/v1/chat')
            .set('Authorization', 'Bearer invalid-token')
            .send({ message: 'hi', chatId: '1' });

        expect(res.statusCode).toEqual(403);
        expect(res.body.error).toEqual('Invalid API Token');
    });

    test('Protected route should succeed with valid token', async () => {
        // Mock Agent Response
        axios.post.mockResolvedValue({
            data: { replies: [{ content: 'Hello', type: 'text' }] }
        });

        const res = await request(app)
            .post('/v1/chat')
            .set('Authorization', `Bearer ${VALID_TOKEN}`)
            .send({ message: 'hi', chatId: '1' });

        expect(res.statusCode).toEqual(200);
        expect(res.body.success).toBe(true);
        expect(res.body.agentResponse.replies[0].content).toEqual('Hello');
    });
});
