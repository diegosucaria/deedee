const request = require('supertest');
const { app } = require('../src/server');

// We are not mocking Telegraf here for simplicity in this smoke test,
// but since TELEGRAM_TOKEN is missing in test env, it won't start.

describe('Interfaces API', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /send should fail if service not enabled', async () => {
    const res = await request(app)
      .post('/send')
      .send({ 
        source: 'telegram', 
        content: 'hello',
        metadata: { chatId: '123' } 
      });
    
    // It should fail because TELEGRAM_TOKEN is not set in test env
    expect(res.statusCode).toBe(400); 
  });
});
