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

describe('the voice call tool route sits behind the internal token', () => {
  const saved = process.env.DEEDEE_INTERNAL_TOKEN;
  afterEach(() => { if (saved === undefined) delete process.env.DEEDEE_INTERNAL_TOKEN; else process.env.DEEDEE_INTERNAL_TOKEN = saved; });

  test('no token, or a wrong one, is refused before any tool is looked at', async () => {
    process.env.DEEDEE_INTERNAL_TOKEN = 'test-internal-token';
    const none = await request(app).post('/tools/execute').send({ name: 'runShellCommand', args: { command: 'id' } });
    expect(none.statusCode).toBe(401);
    const wrong = await request(app).post('/tools/execute').set('Authorization', 'Bearer nope').send({ name: 'getFact', args: {} });
    expect(wrong.statusCode).toBe(401);
  });

  test('the right token gets past the check', async () => {
    process.env.DEEDEE_INTERNAL_TOKEN = 'test-internal-token';
    const res = await request(app).post('/tools/execute').set('Authorization', 'Bearer test-internal-token').send({ name: 'getFact', args: { key: 'x' } });
    // 200 with an agent, 404 or 503 without one in this test process: never 401.
    expect(res.statusCode).not.toBe(401);
  });
});

afterAll(async () => {
  // If agent was started by server.js (side-effect), we must stop it.
  const { agent } = require('../src/server');
  if (agent) {
    await agent.stop();
  }
});

