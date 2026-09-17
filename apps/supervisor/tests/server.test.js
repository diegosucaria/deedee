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
          pull: jest.fn().mockResolvedValue({ success: true }),
          isTracked: jest.fn(async (file) => file === 'apps/agent/src/a.js')
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

  test('GET /cmd/tracked answers from the supervisor and needs the token', async () => {
    const yes = await request(app).get('/cmd/tracked').query({ path: 'apps/agent/src/a.js' }).set('x-supervisor-token', 'test-token');
    expect(yes.body).toEqual({ tracked: true });
    const no = await request(app).get('/cmd/tracked').query({ path: 'notes.env' }).set('x-supervisor-token', 'test-token');
    expect(no.body).toEqual({ tracked: false });
    const denied = await request(app).get('/cmd/tracked').query({ path: 'apps/agent/src/a.js' });
    expect(denied.statusCode).toBe(403);
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

  test('GET /logs stops a balena stream that opens after the client left', async () => {
    jest.resetModules();
    const stop = jest.fn();
    let opened;
    const opening = new Promise((resolve) => { opened = resolve; });
    let started;
    const streamStarted = new Promise((resolve) => { started = resolve; });
    jest.doMock('../src/balena-logs', () => ({
      balenaApiAvailable: () => true,
      BalenaLogs: jest.fn().mockImplementation(() => ({
        stream: jest.fn(async () => { started(); await opening; return { stop }; })
      }))
    }));
    const http = require('http');
    const server = require('../src/server').app.listen(0);
    try {
      const port = server.address().port;
      const req = http.get({ port, path: '/logs/agent', headers: { 'x-supervisor-token': 'test-token' } });
      req.on('error', () => {});
      await streamStarted;
      req.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stop).not.toHaveBeenCalled();
      opened();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      jest.dontMock('../src/balena-logs');
    }
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
