const request = require('supertest');

describe('Interfaces API Tests', () => {
  let app;
  let originalEnv;
  let mockAxios;

  beforeAll(() => {
    originalEnv = process.env;
    // Suppress logs for cleaner test output
    jest.spyOn(console, 'log').mockImplementation(() => { });
    jest.spyOn(console, 'error').mockImplementation(() => { });
    jest.spyOn(console, 'warn').mockImplementation(() => { });
  });

  beforeEach(() => {
    jest.resetModules(); // Clears cache so we can re-require server.js
    process.env = { ...originalEnv };
    // Default valid token
    process.env.DEEDEE_API_TOKEN = 'valid-token';
    process.env.TELEGRAM_TOKEN = '';
    process.env.ENABLE_WHATSAPP = 'false';

    // Setup Axios Mock
    mockAxios = {
      get: jest.fn(() => Promise.resolve({ data: {} })),
      post: jest.fn(() => Promise.resolve({ data: {} })),
      put: jest.fn(() => Promise.resolve({ data: {} })),
      delete: jest.fn(() => Promise.resolve({ data: {} })),
      isAxiosError: jest.fn((err) => !!err?.isAxiosError),
      defaults: { headers: { common: {} } },
      create: jest.fn(() => ({
        get: jest.fn(),
        post: jest.fn(),
        interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } }
      }))
    };

    // Use doMock to ensure dynamic require gets the mock
    jest.doMock('axios', () => mockAxios);

    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  async function loadApp() {
    const serverModule = require('../src/server');
    return serverModule.app;
  }

  describe('Auth & Smoke', () => {
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
  });

  describe('Session Management', () => {
    test('GET /sessions should forward to Agent', async () => {
      mockAxios.get.mockResolvedValue({ data: { sessions: [] } });
      app = await loadApp();

      const res = await request(app)
        .get('/sessions')
        .set('Authorization', 'Bearer valid-token');

      expect(res.statusCode).toBe(200);
      expect(mockAxios.get).toHaveBeenCalledWith(expect.stringContaining('/internal/sessions'), expect.anything());
    });

    test('POST /sessions should forward to Agent', async () => {
      mockAxios.post.mockResolvedValue({ data: { id: 'new-session' } });
      app = await loadApp();

      const res = await request(app)
        .post('/sessions')
        .set('Authorization', 'Bearer valid-token')
        .send({ title: 'New' });

      expect(res.statusCode).toBe(200);
      expect(mockAxios.post).toHaveBeenCalledWith(expect.stringContaining('/internal/sessions'), { title: 'New' });
    });

    test('GET /sessions/:id should fetch metadata AND history', async () => {
      mockAxios.get.mockImplementation((url) => {
        if (url.includes('/internal/sessions/123')) return Promise.resolve({ data: { id: '123', title: 'Chat' } });
        if (url.includes('/internal/history')) return Promise.resolve({ data: { history: ['msg1'] } });
        return Promise.reject(new Error('not found'));
      });
      app = await loadApp();

      const res = await request(app)
        .get('/sessions/123')
        .set('Authorization', 'Bearer valid-token');

      expect(res.statusCode).toBe(200);
      expect(res.body.title).toBe('Chat');
      expect(res.body.messages).toEqual(['msg1']);
    });
  });
});
