/**
 * GET /internal/models feeds the Models tab. The faults it guards against:
 * a role whose price row is a guess is shown as exact; a missing or broken
 * model-smoke.json takes the route down; the route leaks an env value.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { createInternalRouter } = require('../src/routes/internal');
const { ConfigService } = require('../src/services/config-service');

describe('GET /internal/models', () => {
    let app, agent, dataDir, warn;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-models-route-'));
        agent = { dataDir, db: {}, configService: new ConfigService() };
        app = express();
        app.use(express.json());
        app.use('/internal', createInternalRouter(agent));
        delete process.env.DATA_DIR;
        warn = jest.spyOn(console, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        warn.mockRestore();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const smokeFile = () => path.join(dataDir, 'model-smoke.json');

    // ConfigService reads the env once, at import. A test that needs another
    // model id swaps the id map and keeps the real pricing behind it.
    const withModels = (models) => {
        const real = new ConfigService();
        return {
            get: (key) => (key === 'MODELS' ? models : real.get(key)),
            getPricing: (m) => real.getPricing(m),
            getModelThinkingLevels: (m) => real.getModelThinkingLevels(m)
        };
    };

    const routerFor = (configService) => {
        const app2 = express();
        app2.use('/internal', createInternalRouter({ dataDir, db: {}, configService }));
        return app2;
    };

    test('every role comes back with its id, its env var and a price', async () => {
        const res = await request(app).get('/internal/models');
        expect(res.status).toBe(200);
        const roles = res.body.roles.map(r => r.role);
        for (const role of ['ROUTER', 'LITE', 'FLASH', 'PRO', 'IMAGE', 'TTS', 'LIVE', 'EMBEDDING', 'SEARCH']) {
            expect(roles).toContain(role);
        }
        const pro = res.body.roles.find(r => r.role === 'PRO');
        expect(typeof pro.model).toBe('string');
        expect(pro.envVar).toBe('WORKER_PRO');
        expect(pro.price.tier1.input).toBeGreaterThan(0);
        expect(pro.price.tier1.output).toBeGreaterThan(0);
    });

    test('cached input is a tenth of the input rate, the same share the cost sum uses', async () => {
        const res = await request(app).get('/internal/models');
        for (const role of res.body.roles) {
            expect(role.price.tier1.cachedInput).toBeCloseTo(role.price.tier1.input * 0.1, 8);
        }
    });

    test('a price the heuristic guessed is not shown as exact', async () => {
        const app2 = routerFor(withModels({ FLASH: 'gemini-3.9-flash-not-in-the-table' }));
        const res = await request(app2).get('/internal/models');
        const flash = res.body.roles.find(r => r.role === 'FLASH');
        expect(flash.exactPrice).toBe(false);
        // The name heuristic still lands on a real row, so a cost is shown.
        expect(flash.price.tier1.input).toBeGreaterThan(0);
    });

    test('an id set by env says so, an id left alone says default', async () => {
        process.env.WORKER_LITE = 'gemini-3.1-flash-lite';
        try {
            const res = await request(routerFor(new ConfigService())).get('/internal/models');
            expect(res.body.roles.find(r => r.role === 'LITE').source).toBe('env');
        } finally {
            delete process.env.WORKER_LITE;
        }
        const res = await request(app).get('/internal/models');
        expect(res.body.roles.find(r => r.role === 'LITE').source).toBe('default');
    });

    test('no smoke file yet: the route still answers, with no smoke result', async () => {
        const res = await request(app).get('/internal/models');
        expect(res.status).toBe(200);
        expect(res.body.smoke).toBeNull();
        expect(res.body.roles.every(r => r.smoke === null)).toBe(true);
    });

    test('the last smoke run reaches each role', async () => {
        fs.writeFileSync(smokeFile(), JSON.stringify({
            at: '2026-09-20T08:00:00.000Z', ok: 8, failed: 1, skipped: 2,
            roles: [
                { role: 'PRO', status: 'ok', ms: 1200, error: null },
                { role: 'LIVE', status: 'fail', ms: 60000, error: 'timed out after 60000 ms' }
            ]
        }));
        const res = await request(app).get('/internal/models');
        expect(res.body.smoke).toEqual({ at: '2026-09-20T08:00:00.000Z', ok: 8, failed: 1, skipped: 2 });
        expect(res.body.roles.find(r => r.role === 'PRO').smoke).toEqual({ status: 'ok', ms: 1200, error: null });
        expect(res.body.roles.find(r => r.role === 'LIVE').smoke).toEqual({ status: 'fail', ms: 60000, error: 'timed out after 60000 ms' });
        expect(res.body.roles.find(r => r.role === 'TTS').smoke).toBeNull();
    });

    test('a broken smoke file does not take the tab down', async () => {
        fs.writeFileSync(smokeFile(), 'not json at all');
        const res = await request(app).get('/internal/models');
        expect(res.status).toBe(200);
        expect(res.body.smoke).toBeNull();
        expect(res.body.roles.length).toBeGreaterThan(0);
    });

    test('no env value is returned, only the name of the env var', async () => {
        const res = await request(app).get('/internal/models');
        const keys = new Set(res.body.roles.flatMap(r => Object.keys(r)));
        expect([...keys].sort()).toEqual(['envVar', 'exactPrice', 'model', 'price', 'role', 'smoke', 'source', 'thinkingLevels']);
    });

    test('with no config service the route says so instead of crashing', async () => {
        const app2 = express();
        app2.use('/internal', createInternalRouter({ dataDir, db: {} }));
        const res = await request(app2).get('/internal/models');
        expect(res.status).toBe(503);
    });
});
