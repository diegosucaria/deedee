const { AgentDB } = require('../src/db');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('AgentDB Settings', () => {
    let db;
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-test-'));
        db = new AgentDB(tmpDir);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should set and get agent settings', () => {
        const key = 'test:key';
        const value = { foo: 'bar' };

        db.setAgentSetting(key, value);

        const retrieved = db.getAgentSetting(key);
        expect(retrieved).toEqual({ key, value });
    });

    it('should get all settings', () => {
        db.setAgentSetting('k1', 'v1');
        db.setAgentSetting('k2', { v: 2 });

        expect(db.getAllAgentSettings()).toEqual({
            k1: 'v1',
            k2: { v: 2 }
        });
    });

    it('hides system rows such as the migration flag', () => {
        // init() records the one-time message timestamp migration in the 'system' category.
        expect(db.getAgentSetting('migration_messages_ts_iso')).not.toBeNull();
        db.setAgentSetting('k1', 'v1');
        db.setAgentSetting('internal_flag', true, 'system');

        expect(db.getAllAgentSettings()).toEqual({ k1: 'v1' });
    });

    it('should update existing setting', () => {
        db.setAgentSetting('k1', 'v1');
        db.setAgentSetting('k1', 'v2');

        const retrieved = db.getAgentSetting('k1');
        expect(retrieved.value).toBe('v2');
    });
});
