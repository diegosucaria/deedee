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

  describe('Internal routes (agent only)', () => {
    const PATH = '/internal/whatsapp/messages-by-date?date=2026-09-15';

    test('401 without a token', async () => {
      process.env.DEEDEE_INTERNAL_TOKEN = 'internal-token';
      app = await loadApp();
      const res = await request(app).get(PATH);
      expect(res.statusCode).toBe(401);
    });

    test('401 for a DEEDEE_API_TOKEN holder', async () => {
      process.env.DEEDEE_INTERNAL_TOKEN = 'internal-token';
      app = await loadApp();
      const res = await request(app).get(PATH).set('Authorization', 'Bearer valid-token');
      expect(res.statusCode).toBe(401);
    });

    test('401 when DEEDEE_INTERNAL_TOKEN is unset', async () => {
      delete process.env.DEEDEE_INTERNAL_TOKEN;
      app = await loadApp();
      const res = await request(app).get(PATH).set('Authorization', 'Bearer anything');
      expect(res.statusCode).toBe(401);
    });

    test('the internal token is accepted', async () => {
      process.env.DEEDEE_INTERNAL_TOKEN = 'internal-token';
      app = await loadApp();
      const res = await request(app).get(PATH).set('Authorization', 'Bearer internal-token');
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ messages: [] });
    });

    test('400 for a date that is not YYYY-MM-DD', async () => {
      process.env.DEEDEE_INTERNAL_TOKEN = 'internal-token';
      app = await loadApp();
      const res = await request(app)
        .get('/internal/whatsapp/messages-by-date?date=../../etc')
        .set('Authorization', 'Bearer internal-token');
      expect(res.statusCode).toBe(400);
    });
  });

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

    test('POST /send should return 401 for a token that only shares a prefix', async () => {
      app = await loadApp();
      const res = await request(app)
        .post('/send')
        .set('Authorization', 'Bearer valid-token-and-more')
        .send({ source: 'test', content: 'hello' });

      expect(res.statusCode).toBe(401);
    });

    test('fails closed when DEEDEE_API_TOKEN is unset', async () => {
      delete process.env.DEEDEE_API_TOKEN;
      app = await loadApp();

      const noToken = await request(app)
        .post('/send')
        .send({ source: 'test', content: 'hello' });
      expect(noToken.statusCode).toBe(401);

      // "Bearer undefined" used to pass because undefined === undefined.
      const literalUndefined = await request(app)
        .post('/send')
        .set('Authorization', 'Bearer undefined')
        .send({ source: 'test', content: 'hello' });
      expect(literalUndefined.statusCode).toBe(401);

      const health = await request(app).get('/health');
      expect(health.statusCode).toBe(200);
    });
  });

  describe('POST /send dedupe by message id', () => {
    let telegramSend;

    beforeEach(() => {
      telegramSend = jest.fn().mockResolvedValue({ duplicate: false });
      jest.doMock('../src/telegram', () => ({
        TelegramService: jest.fn().mockImplementation(() => ({
          start: jest.fn().mockResolvedValue(),
          sendMessage: telegramSend,
          sendVoice: jest.fn(),
          sendPhoto: jest.fn()
        }))
      }));
      process.env.TELEGRAM_TOKEN = 'tg-token';
    });

    const send = (body) => request(app).post('/send').set('Authorization', 'Bearer valid-token').send(body);

    test('a repeat of the same id within 24 h is not sent again', async () => {
      app = await loadApp();
      const body = { id: 'msg-1', source: 'telegram', content: 'hello', metadata: { chatId: '42' } };

      const first = await send(body);
      expect(first.statusCode).toBe(200);
      expect(first.body).toEqual({ success: true });
      expect(telegramSend).toHaveBeenCalledWith('42', 'hello', { id: 'msg-1' });

      const again = await send(body);
      expect(again.statusCode).toBe(200);
      expect(again.body).toEqual({ success: true, duplicate: true });
      expect(telegramSend).toHaveBeenCalledTimes(1);

      // A different id, same text, goes out.
      await send({ ...body, id: 'msg-2' });
      expect(telegramSend).toHaveBeenCalledTimes(2);
    });

    test('a failed send does not mark the id, so the retry goes out', async () => {
      app = await loadApp();
      telegramSend.mockRejectedValueOnce(new Error('socket hang up'));
      const body = { id: 'msg-3', source: 'telegram', content: 'hello', metadata: { chatId: '42' } };

      expect((await send(body)).statusCode).toBe(500);
      const retry = await send(body);
      expect(retry.statusCode).toBe(200);
      expect(retry.body).toEqual({ success: true });
      expect(telegramSend).toHaveBeenCalledTimes(2);
    });

    test('sends without an id are never deduped', async () => {
      app = await loadApp();
      const body = { source: 'telegram', content: 'hello', metadata: { chatId: '42' } };
      await send(body);
      await send(body);
      expect(telegramSend).toHaveBeenCalledTimes(2);
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

  describe('WhatsApp disconnect', () => {
    test('POST /whatsapp/disconnect answers once the session is cleared', async () => {
      process.env.ENABLE_WHATSAPP = 'true';
      const disconnect = jest.fn(() => Promise.resolve());
      jest.doMock('../src/whatsapp', () => ({
        WhatsAppService: class {
          start() { return Promise.resolve(); }
          disconnect(...args) { return disconnect(...args); }
        }
      }));
      app = await loadApp();

      const res = await request(app)
        .post('/whatsapp/disconnect')
        .set('Authorization', 'Bearer valid-token')
        .send({ session: 'user' });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(disconnect).toHaveBeenCalledWith(true);
    });
  });
});
