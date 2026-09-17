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
          git: jest.fn().mockResolvedValue('hash\towner@example.test\tmock subject'),
          listSelfPullRequests: jest.fn(() => []),
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

  test('fails closed when SUPERVISOR_TOKEN is unset', async () => {
    delete process.env.SUPERVISOR_TOKEN;

    const noHeader = await request(app).post('/cmd/commit').send({ message: 'test commit' });
    expect(noHeader.statusCode).toBe(401);

    // 'undefined' === undefined was never true, but make the fail-closed path explicit.
    const literalUndefined = await request(app)
      .post('/cmd/commit')
      .set('x-supervisor-token', 'undefined')
      .send({ message: 'test commit' });
    expect(literalUndefined.statusCode).toBe(401);

    const rollback = await request(app).post('/cmd/rollback');
    expect(rollback.statusCode).toBe(401);

    const pull = await request(app).post('/cmd/pull');
    expect(pull.statusCode).toBe(401);

    const health = await request(app).get('/health');
    expect(health.statusCode).toBe(200);
  });

  test('rejects missing, wrong and prefix-sharing tokens', async () => {
    const missing = await request(app).post('/cmd/commit').send({ message: 'test commit' });
    expect(missing.statusCode).toBe(403);

    const wrong = await request(app)
      .post('/cmd/commit')
      .set('x-supervisor-token', 'test-tokem')
      .send({ message: 'test commit' });
    expect(wrong.statusCode).toBe(403);

    const longer = await request(app)
      .post('/cmd/commit')
      .set('x-supervisor-token', 'test-token-and-more')
      .send({ message: 'test commit' });
    expect(longer.statusCode).toBe(403);
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

  test('GET /logs refuses a service outside the list when the balena API is in use', async () => {
    process.env.BALENA_SUPERVISOR_ADDRESS = 'http://127.0.0.1:1';
    process.env.BALENA_SUPERVISOR_API_KEY = 'key';
    try {
      const res = await request(app).get('/logs/balena_supervisor').set('x-supervisor-token', 'test-token');
      expect(res.statusCode).toBe(404);
    } finally {
      delete process.env.BALENA_SUPERVISOR_ADDRESS;
      delete process.env.BALENA_SUPERVISOR_API_KEY;
    }
  });
});
