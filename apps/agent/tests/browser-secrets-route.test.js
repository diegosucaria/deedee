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

    test('PUT writes one secret to JSON and dotenv, then restarts the browser server', async () => {
        const res = await request(app).put('/internal/browser-secrets/SITE_PASS').send({ value: 'p"q' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, count: 1, restart: { restarted: true } });
        expect(agent.mcp.restartServer).toHaveBeenCalledWith('browser');

        const dir = path.join(dataDir, 'browser_profile');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'browser-secrets.json'), 'utf8'))).toEqual({ SITE_PASS: 'p"q' });
        expect(fs.readFileSync(path.join(dir, 'browser-secrets.env'), 'utf8')).toBe("SITE_PASS='p\"q'\n");
    });

    test('a second PUT leaves the other secrets alone', async () => {
        await request(app).put('/internal/browser-secrets/SITE_USER').send({ value: 'u' });
        await request(app).put('/internal/browser-secrets/SITE_PASS').send({ value: 'p' });

        const json = path.join(dataDir, 'browser_profile', 'browser-secrets.json');
        expect(JSON.parse(fs.readFileSync(json, 'utf8'))).toEqual({ SITE_USER: 'u', SITE_PASS: 'p' });
    });

    test('GET returns names only, never a value', async () => {
        await request(app).put('/internal/browser-secrets/SITE_USER').send({ value: 'u' });
        await request(app).put('/internal/browser-secrets/SITE_PASS').send({ value: 'hunter2' });

        const get = await request(app).get('/internal/browser-secrets');
        expect(get.body).toEqual({ names: ['SITE_PASS', 'SITE_USER'] });
        expect(JSON.stringify(get.body)).not.toContain('hunter2');
    });

    test('DELETE removes one secret and restarts the server', async () => {
        await request(app).put('/internal/browser-secrets/SITE_USER').send({ value: 'u' });
        await request(app).put('/internal/browser-secrets/SITE_PASS').send({ value: 'p' });
        agent.mcp.restartServer.mockClear();

        const res = await request(app).delete('/internal/browser-secrets/SITE_PASS');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, count: 1, restart: { restarted: true } });
        expect(agent.mcp.restartServer).toHaveBeenCalledWith('browser');

        const get = await request(app).get('/internal/browser-secrets');
        expect(get.body).toEqual({ names: ['SITE_USER'] });
    });

    test('DELETE of an unknown name is a 404 and changes nothing', async () => {
        await request(app).put('/internal/browser-secrets/SITE_USER').send({ value: 'u' });
        agent.mcp.restartServer.mockClear();

        const res = await request(app).delete('/internal/browser-secrets/NOPE');
        expect(res.status).toBe(404);
        expect(agent.mcp.restartServer).not.toHaveBeenCalled();
    });

    test('PUT reports a deferred restart', async () => {
        agent.mcp.restartServer.mockResolvedValue({ deferred: true });
        const res = await request(app).put('/internal/browser-secrets/A').send({ value: 'b' });
        expect(res.body.restart).toEqual({ deferred: true });
    });

    test('PUT rejects a bad name and writes nothing', async () => {
        const res = await request(app).put('/internal/browser-secrets/bad%20key').send({ value: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Invalid secret name');
        expect(fs.existsSync(path.join(dataDir, 'browser_profile', 'browser-secrets.json'))).toBe(false);
        expect(agent.mcp.restartServer).not.toHaveBeenCalled();
    });

    test('PUT rejects a value that is not a string', async () => {
        const res = await request(app).put('/internal/browser-secrets/A').send({ value: { nested: true } });
        expect(res.status).toBe(400);
    });

    test('GET returns no names when nothing is saved', async () => {
        const res = await request(app).get('/internal/browser-secrets');
        expect(res.body).toEqual({ names: [] });
    });
});
