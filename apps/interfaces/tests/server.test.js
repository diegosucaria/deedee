const request = require('supertest');

describe('Interfaces API Auth & Smoke Tests', () => {
  let app;
  let originalEnv;

  beforeAll(() => {
    originalEnv = process.env;
  });

  beforeEach(() => {
    jest.resetModules(); // Important: Clears cache so we can re-require server.js
    process.env = { ...originalEnv }; // Reset env vars
    // Default valid token
    process.env.DEEDEE_API_TOKEN = 'valid-token';
    process.env.TELEGRAM_TOKEN = ''; // Disable telegram start
    process.env.ENABLE_WHATSAPP = 'false'; // Disable whatsapp start

    // Quiet console
    jest.spyOn(console, 'log').mockImplementation(() => { });
    jest.spyOn(console, 'error').mockImplementation(() => { });
    jest.spyOn(console, 'warn').mockImplementation(() => { });
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  async function loadApp() {
    const serverModule = require('../src/server');
    return serverModule.app;
  }

  test('GET /health should be public (no auth needed)', async () => {
    app = await loadApp();
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /send should return 401 if no token provided', async () => {
    app = await loadApp();
    const res = await request(app)
      .post('/send')
      .send({ source: 'test', content: 'hello' });

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  test('POST /send should return 401 if invalid token provided', async () => {
    app = await loadApp();
    const res = await request(app)
      .post('/send')
      .set('Authorization', 'Bearer invalid-token')
      .send({ source: 'test', content: 'hello' });

    expect(res.statusCode).toBe(401);
  });

  test('POST /send should return 400 (not 401) if valid token provided but invalid body', async () => {
    process.env.DEEDEE_API_TOKEN = 'secret-123';
    app = await loadApp();

    const res = await request(app)
      .post('/send')
      .set('Authorization', 'Bearer secret-123')
      .send({ source: 'bad-source' }); // Invalid source usually throws 400 or 500 downstream, but NOT 401

    expect(res.statusCode).not.toBe(401);
  });
});
