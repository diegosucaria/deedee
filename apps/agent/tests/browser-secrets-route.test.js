const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { createInternalRouter } = require('../src/routes/internal');

describe('Internal Router - browser secrets', () => {
    let app;
    let agent;
    let dataDir;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-secrets-route-'));
        agent = {
            dataDir,
            db: {},
            mcp: {
                config: { browser: { command: 'node' } },
                restartServer: jest.fn().mockResolvedValue({ restarted: true })
            }
        };
        app = express();
        app.use(express.json());
        app.use('/internal', createInternalRouter(agent));
        delete process.env.DATA_DIR;
    });

    test('POST writes JSON and dotenv, then restarts the browser server', async () => {
        const res = await request(app).post('/internal/browser-secrets').send({ SITE_USER: 'u', SITE_PASS: 'p"q' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, count: 2, restart: { restarted: true } });
        expect(agent.mcp.restartServer).toHaveBeenCalledWith('browser');

        const dir = path.join(dataDir, 'browser_profile');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'browser-secrets.json'), 'utf8'))).toEqual({ SITE_USER: 'u', SITE_PASS: 'p"q' });
        expect(fs.readFileSync(path.join(dir, 'browser-secrets.env'), 'utf8')).toBe("SITE_USER='u'\nSITE_PASS='p\"q'\n");

        const get = await request(app).get('/internal/browser-secrets');
        expect(get.body).toEqual({ SITE_USER: 'u', SITE_PASS: 'p"q' });
    });

    test('POST reports a deferred restart', async () => {
        agent.mcp.restartServer.mockResolvedValue({ deferred: true });
        const res = await request(app).post('/internal/browser-secrets').send({ A: 'b' });
        expect(res.body.restart).toEqual({ deferred: true });
    });

    test('POST rejects bad keys and writes nothing', async () => {
        const res = await request(app).post('/internal/browser-secrets').send({ 'bad key': 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Invalid secret name');
        expect(fs.existsSync(path.join(dataDir, 'browser_profile', 'browser-secrets.json'))).toBe(false);
        expect(agent.mcp.restartServer).not.toHaveBeenCalled();
    });

    test('POST rejects a non-object body', async () => {
        const res = await request(app).post('/internal/browser-secrets').send(['A']);
        expect(res.status).toBe(400);
    });

    test('GET returns {} when nothing is saved', async () => {
        const res = await request(app).get('/internal/browser-secrets');
        expect(res.body).toEqual({});
    });
});
