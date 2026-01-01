const request = require('supertest');
const { app } = require('../src/server');

// Mock dependencies if needed, but for now we just check endpoints.
// Note: Since GOOGLE_API_KEY is missing in test env, Agent won't start, 
// so /webhook might return 503. That's fine for testing the plumbing.

describe('Agent Server API', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /webhook without Agent', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({ content: 'test', source: 'telegram' });
    
    // Expect 503 because no API key -> no agent
    expect(res.statusCode).toBe(503);
  });
});
