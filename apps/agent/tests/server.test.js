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

describe('every route but /health sits behind the internal token', () => {
  const saved = process.env.DEEDEE_INTERNAL_TOKEN;
  beforeEach(() => { process.env.DEEDEE_INTERNAL_TOKEN = 'test-internal-token'; });
  afterEach(() => { if (saved === undefined) delete process.env.DEEDEE_INTERNAL_TOKEN; else process.env.DEEDEE_INTERNAL_TOKEN = saved; });
  const withToken = (req) => req.set('Authorization', 'Bearer test-internal-token');

  test('the routes that used to trust the Docker network now refuse a call with no token', async () => {
    // A message posted to /chat counts as typed on the owner's side, and the
    // agent's own shell tool runs inside that network.
    expect((await request(app).post('/chat').send({ content: 'hi', source: 'web' })).statusCode).toBe(401);
    expect((await request(app).post('/webhook').send({ content: 'hi', source: 'telegram' })).statusCode).toBe(401);
    expect((await request(app).get('/status')).statusCode).toBe(401);
    expect((await request(app).get('/live/config')).statusCode).toBe(401);
    expect((await request(app).post('/live/token').send({})).statusCode).toBe(401);
    expect((await request(app).get('/v1/vaults')).statusCode).toBe(401);
    expect((await request(app).get('/internal/tools')).statusCode).toBe(401);
  });

  test('a wrong token is refused the same way', async () => {
    const res = await request(app).post('/chat').set('Authorization', 'Bearer nope').send({ content: 'hi' });
    expect(res.statusCode).toBe(401);
  });

  test('/health stays open: the supervisor and the gateway poll it with no token', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('the right token gets past the check on the routes that were open', async () => {
    expect((await withToken(request(app).get('/status'))).statusCode).toBe(200);
    expect((await withToken(request(app).get('/live/config'))).statusCode).toBe(200);
    // 200 with an agent, 503 without one in this test process: never 401.
    expect((await withToken(request(app).post('/webhook')).send({ content: 'hi', source: 'telegram' })).statusCode).not.toBe(401);
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

