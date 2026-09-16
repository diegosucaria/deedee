const { AgentDB } = require('../src/db');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('subagents.result_full', () => {
    let db;
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-full-'));
        db = new AgentDB(dir);
    });

    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('stores the full text next to the compressed result; lists leave it out', () => {
        db.createSubAgent({ id: 'sub-1', parentChatId: 'chat-a', task: 'scan', model: 'LITE', createdAt: new Date().toISOString() });
        db.updateSubAgent('sub-1', { status: 'completed', result: 'short', resultFull: 'x'.repeat(9000), completedAt: new Date().toISOString() });

        const row = db.getSubAgent('sub-1');
        expect(row.result).toBe('short');
        expect(row.result_full.length).toBe(9000);

        const byParent = db.listSubAgents('chat-a').tasks[0];
        expect(byParent.result).toBe('short');
        expect(byParent).not.toHaveProperty('result_full');

        const all = db.listSubAgents(null, { page: 1, limit: 10 }).tasks[0];
        expect(all.id).toBe('sub-1');
        expect(all).not.toHaveProperty('result_full');
    });

    test('an update without resultFull keeps the column untouched', () => {
        db.createSubAgent({ id: 'sub-2', parentChatId: 'chat-a', task: 'scan', model: 'FLASH', createdAt: new Date().toISOString() });
        db.updateSubAgent('sub-2', { status: 'completed', result: 'done' });
        expect(db.getSubAgent('sub-2').result_full).toBeNull();
    });
});
