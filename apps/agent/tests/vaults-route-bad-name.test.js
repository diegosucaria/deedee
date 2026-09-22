/**
 * The vault file route had its own copy of the name sanitiser, which never
 * refused a name. It now uses VaultManager's, which refuses a name with no
 * letter or digit before any path is built.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const VaultManager = require('../src/vault-manager');
const createVaultRouter = require('../src/routes/vaults');

describe('GET /v1/vaults/:id/files/:filename', () => {
    let dir, app, vaults;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-vault-route-'));
        vaults = new VaultManager(dir);
        await vaults.initialize();
        app = express();
        app.use('/v1/vaults', createVaultRouter({ vaults }));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('a name with no letter or digit is refused with 400, not looked up in the vaults folder', async () => {
        const res = await request(app).get('/v1/vaults/.../files/notes.txt');
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/no letters or digits/);
    });

    test('a real vault and a missing file: 404', async () => {
        const res = await request(app).get('/v1/vaults/health/files/nope.txt');
        expect(res.statusCode).toBe(404);
    });
});
