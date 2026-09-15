const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Supervisor API', () => {
  let app;
  let stateDir;

  beforeEach(() => {
    jest.resetModules(); // Ensure clean state
    process.env.SUPERVISOR_TOKEN = 'test-token';
    // Keep the monitor's state files out of /app/state on the test machine
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-state-'));
    process.env.SUPERVISOR_STATE_DIR = stateDir;
    // Mock GitOps BEFORE requiring app
    jest.mock('../src/git-ops', () => {
      return {
        GitOps: jest.fn().mockImplementation(() => ({
          configure: jest.fn().mockResolvedValue(),
          commitAndPush: jest.fn().mockImplementation(async (msg) => {
            if (msg === 'fail validation') return { success: false, error: 'Syntax Error' };
            return { success: true, message: 'Mock Pushed' };
          }),
          workDir: '/tmp/mock-source',
          run: jest.fn().mockResolvedValue('hash'),
          runSafe: jest.fn().mockResolvedValue('hash\towner@example.test\tmock subject'),
          rollback: jest.fn().mockResolvedValue({ success: true }),
          pull: jest.fn().mockResolvedValue({ success: true })
        }))
      };
    });

    // Require app AFTER mocking
    app = require('../src/server').app;
  });

  afterEach(() => {
    delete process.env.SUPERVISOR_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('GET /health', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('POST /cmd/commit success', async () => {
    const res = await request(app)
      .post('/cmd/commit')
      .set('x-supervisor-token', 'test-token')
      .send({ message: 'test commit', files: ['.'] });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /cmd/commit failure (validation)', async () => {
    const res = await request(app)
      .post('/cmd/commit')
      .set('x-supervisor-token', 'test-token')
      .send({ message: 'fail validation', files: ['.'] });

    expect(res.statusCode).toBe(200); // 200 OK because we return error in body
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Syntax Error');
  });
});
