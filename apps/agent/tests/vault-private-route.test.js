/**
 * The route behind the Private switch on a vault page. It sits under
 * /v1/vaults, so the internal token check at the top of server.js covers it;
 * what is tested here is what it does with what it is given.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const VaultManager = require('../src/vault-manager');
const { AgentDB } = require('../src/db');
const createVaultRouter = require('../src/routes/vaults');

describe('POST /v1/vaults/:id/private', () => {
    let dir, app, vaults, db;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-vault-private-route-'));
        process.env.DATA_DIR = dir;
        jest.spyOn(console, 'log').mockImplementation(() => { });
        vaults = new VaultManager(dir);
        await vaults.initialize();
        db = new AgentDB(dir);
        app = express();
        app.use(express.json());
        app.use('/v1/vaults', createVaultRouter({ vaults, db }));
    });

    afterEach(() => {
        try { db.close(); } catch { }
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('marking a vault private stores the flag', async () => {
        const res = await request(app).post('/v1/vaults/health/private').send({ private: true });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, id: 'health', private: true });
        expect(db.isVaultPrivate('health')).toBe(true);
    });

    test('the switch goes both ways', async () => {
        await request(app).post('/v1/vaults/health/private').send({ private: true });
        const res = await request(app).post('/v1/vaults/health/private').send({ private: false });
        expect(res.statusCode).toBe(200);
        expect(db.isVaultPrivate('health')).toBe(false);
    });

    test('a body that is not true or false is refused', async () => {
        for (const body of [{}, { private: 'yes' }, { private: 1 }]) {
            const res = await request(app).post('/v1/vaults/health/private').send(body);
            expect(res.statusCode).toBe(400);
        }
        expect(db.getPrivateVaultIds()).toEqual([]);
    });

    test('a vault that does not exist is a 404, and writes nothing', async () => {
        const res = await request(app).post('/v1/vaults/nosuchvault/private').send({ private: true });
        expect(res.statusCode).toBe(404);
        expect(db.getPrivateVaultIds()).toEqual([]);
    });

    test('a name with no letter or digit is refused before any key is written', async () => {
        const res = await request(app).post('/v1/vaults/.../private').send({ private: true });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/no letters or digits/);
        expect(db.getPrivateVaultIds()).toEqual([]);
    });

    test('the vault list and the vault page both say whether it is private', async () => {
        await request(app).post('/v1/vaults/health/private').send({ private: true });

        const list = await request(app).get('/v1/vaults');
        expect(list.body.find(v => v.id === 'health').private).toBe(true);
        expect(list.body.find(v => v.id === 'finance').private).toBe(false);

        const one = await request(app).get('/v1/vaults/health');
        expect(one.body.private).toBe(true);
    });
});
