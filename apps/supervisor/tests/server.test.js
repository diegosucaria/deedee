const request = require('supertest');
const { app } = require('../src/server');

// Mock GitOps
jest.mock('../src/git-ops', () => {
  return {
    GitOps: jest.fn().mockImplementation(() => ({
      configure: jest.fn().mockResolvedValue(),
      commitAndPush: jest.fn().mockResolvedValue({ success: true, message: 'Mock Pushed' })
    }))
  };
});

describe('Supervisor API', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /cmd/commit', async () => {
    const res = await request(app)
      .post('/cmd/commit')
      .send({ message: 'test commit', files: ['.'] });
    
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
