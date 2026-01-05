const request = require('supertest');
const { app } = require('../src/server');

// Mock GitOps
jest.mock('../src/git-ops', () => {
  return {
    GitOps: jest.fn().mockImplementation(() => ({
      configure: jest.fn().mockResolvedValue(),
      // Mocking successful push
      commitAndPush: jest.fn().mockImplementation(async (msg) => {
        if (msg === 'fail validation') return { success: false, error: 'Syntax Error' };
        return { success: true, message: 'Mock Pushed' };
      }),
      workDir: '/tmp/mock-source',
      run: jest.fn().mockResolvedValue('hash|mock subject')
    }))
  };
});

describe('Supervisor API', () => {
  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /cmd/commit success', async () => {
    const res = await request(app)
      .post('/cmd/commit')
      .send({ message: 'test commit', files: ['.'] });
    
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /cmd/commit failure (validation)', async () => {
    const res = await request(app)
      .post('/cmd/commit')
      .send({ message: 'fail validation', files: ['.'] });
    
    expect(res.statusCode).toBe(200); // 200 OK because we return error in body
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Syntax Error');
  });
});
