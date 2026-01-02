const request = require('supertest');
const { app } = require('../src/server');

// We are not mocking Telegraf here for simplicity in this smoke test,
// but since TELEGRAM_TOKEN is missing in test env, it won't start.

describe('Interfaces API', () => {
  let originalEnv;

  beforeAll(() => {
    originalEnv = process.env.TELEGRAM_TOKEN;
  });

  afterAll(() => {
    process.env.TELEGRAM_TOKEN = originalEnv;
  });

  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /send should fail if service not enabled', async () => {
    // Force telegram to be disabled for this test by ensuring a fresh app or state
    // In this simple setup, if TELEGRAM_TOKEN was already set, 'app' already has it.
    // This test is brittle because 'app' is a singleton.
    
    const res = await request(app)
      .post('/send')
      .send({ 
        source: 'non_existent_service', 
        content: 'hello',
        metadata: { chatId: '123' } 
      });
    
    expect(res.statusCode).toBe(400); 
  });
});
