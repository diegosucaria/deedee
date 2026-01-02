const request = require('supertest');
const { app } = require('../src/server');

describe('Agent Server API', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /webhook behavior', async () => {
    const res = await request(app)
      .post('/webhook')
      .send({ content: 'test', source: 'telegram' });

    // It can be 200 (if key exists) or 503 (if no key)
    // We just want to ensure it doesn't 404 or 500
    expect([200, 503]).toContain(res.statusCode);
  });
});

afterAll(async () => {
  // If agent was started by server.js (side-effect), we must stop it.
  const { agent } = require('../src/server');
  if (agent) {
    await agent.stop();
  }
});
