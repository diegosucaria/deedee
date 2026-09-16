const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { AgentDB } = require('../src/db');
const { DAILY_SQL, COMPOSITION_SQL, PREFIX_SQL, parseArgs, resolveDbPath } = require('../scripts/usage-report');

describe('usage-report script', () => {
    const dataDir = path.join(__dirname, 'test_usage_report_data');
    const script = path.join(__dirname, '..', 'scripts', 'usage-report.js');

    beforeEach(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
        const db = new AgentDB(dataDir);
        db.init();
        db.logTokenUsage({ model: 'model-a', promptTokens: 1000, candidateTokens: 20, totalTokens: 1020, chatId: 'c1', estimatedCost: 0.001, tag: 'chat', cachedTokens: 400, sysTokensEst: 500, toolsTokensEst: 300, historyTokensEst: 100, declCount: 40 });
        db.logTokenUsage({ model: 'model-a', promptTokens: 1200, candidateTokens: 20, totalTokens: 1220, chatId: 'c1', estimatedCost: 0.0012, tag: 'chat_tool_loop', cachedTokens: 900, sysTokensEst: 500, toolsTokensEst: 300, historyTokensEst: 100, declCount: 40 });
        db.logTokenUsage({ model: 'model-b', promptTokens: 9000, candidateTokens: 20, totalTokens: 9020, chatId: 'c2', estimatedCost: 0.02 });
        db.logMetric('prefix_hash', 0, { chatId: 'c1' });
        db.logMetric('prefix_hash', 1, { chatId: 'c1' });
        db.close();
    });

    afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    test('the three queries run against the agent schema', () => {
        const db = new AgentDB(dataDir);
        db.init();
        const daily = db.db.prepare(DAILY_SQL).all('-7 day');
        expect(daily[0]).toMatchObject({ model: 'model-b', tag: null, n: 1 });
        expect(daily.find(r => r.tag === 'chat_tool_loop').cached_ratio).toBeCloseTo(0.75, 6);
        const comp = db.db.prepare(COMPOSITION_SQL).all('-7 day');
        expect(comp).toHaveLength(2);
        expect(comp.every(r => r.sys_est === 500 && r.decls === 40)).toBe(true);
        const prefix = db.db.prepare(PREFIX_SQL).all('-7 day');
        expect(prefix).toHaveLength(1);
        expect(prefix[0]).toMatchObject({ turns: 2, changed: 1 });
        db.close();
    });

    test('parseArgs and resolveDbPath', () => {
        expect(parseArgs([])).toEqual({ days: 7, db: null, json: false });
        expect(parseArgs(['--days', '30', '--json', '--db', '/x/agent.db'])).toEqual({ days: 30, db: '/x/agent.db', json: true });
        expect(resolveDbPath('/y/agent.db')).toBe('/y/agent.db');
        const prev = process.env.DATA_DIR;
        process.env.DATA_DIR = '/z';
        expect(resolveDbPath()).toBe(path.join('/z', 'agent.db'));
        if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
    });

    test('prints the tables and a JSON form', () => {
        const dbPath = path.join(dataDir, 'agent.db');
        const text = execFileSync('node', [script, '--db', dbPath, '--days', '3'], { encoding: 'utf8' });
        expect(text).toContain('untagged rows: 1');
        expect(text).toContain('chat_tool_loop');
        expect(text).toContain('Prefix hash changes: 1 of 2 turn(s)');
        const json = JSON.parse(execFileSync('node', [script, '--db', dbPath, '--json'], { encoding: 'utf8' }));
        expect(json.untagged).toBe(1);
        expect(json.prefixChanges).toBe(1);
        expect(json.daily).toHaveLength(3);
    });
});
