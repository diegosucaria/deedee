const request = require('supertest');

jest.mock('../src/mcp-manager', () => ({
  MCPManager: jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    getTools: jest.fn().mockResolvedValue([]),
    callTool: jest.fn(),
    close: jest.fn()
  }))
}));

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

  test('GET /live/config should return model', async () => {
    // Mock process.env just for this test if possible, or rely on default
    const res = await request(app).get('/live/config');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('model');
  });
});

afterAll(async () => {
  // If agent was started by server.js (side-effect), we must stop it.
  const { agent } = require('../src/server');
  if (agent) {
    await agent.stop();
  }
});

