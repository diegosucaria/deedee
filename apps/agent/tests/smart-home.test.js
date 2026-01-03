const { AgentDB } = require('../src/db');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Smart Home Features', () => {
    let db;
    let tmpDir;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-smart-home-test-'));
        process.env.DATA_DIR = tmpDir;
        db = new AgentDB(tmpDir); // Force new instance in tmp
    });

    afterAll(() => {
        if (db && db.db) db.db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('should save and retrieve device aliases', () => {
        const alias = 'hallway light';
        const entityId = 'light.hallway_main_1';

        // 1. Initially null
        expect(db.getDeviceAlias(alias)).toBeNull();

        // 2. Save
        db.saveDeviceAlias(alias, entityId);

        // 3. Retrieve
        expect(db.getDeviceAlias(alias)).toBe(entityId);
    });

    test('should update existing alias', () => {
        const alias = 'hallway light';
        const newEntityId = 'light.hallway_v2';

        db.saveDeviceAlias(alias, newEntityId);
        expect(db.getDeviceAlias(alias)).toBe(newEntityId);
    });

    test('should be case insensitive for lookup', () => {
        const alias = 'Kitchen Lamp';
        const entityId = 'light.kitchen';

        db.saveDeviceAlias(alias, entityId);
        expect(db.getDeviceAlias('kitchen lamp')).toBe(entityId);
        expect(db.getDeviceAlias('KITCHEN LAMP')).toBe(entityId);
    });
});
