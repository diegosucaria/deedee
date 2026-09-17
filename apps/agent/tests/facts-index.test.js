/**
 * The facts index: the prompt carries one line per fact inside a budget
 * instead of every fact in full (642 rows, about 13k tokens on the device),
 * and the tools reach the rest on request.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { Agent } = require('../src/agent');
const { MemoryExecutor } = require('../src/executors/memory');

function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-facts-'));
    return { dir, db: new AgentDB(dir) };
}

// The tool branches read only `this.db`, so a thin object exercises them.
const runTool = (db, name, args) => Agent.prototype._executeTool.call({ db }, name, args, { metadata: {} });

describe('the facts index', () => {
    let dir, db, spies;

    beforeEach(() => {
        ({ dir, db } = tempDb());
        spies = ['log', 'warn'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        spies.forEach(s => s.mockRestore());
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('splits the owner from the agent, and leaves state out', () => {
        db.setKey('user_home_city', 'Springfield', { category: 'general' });
        db.setKey('relationship_sister_name', 'Ada', { category: 'relationship' });
        db.setKey('device_kitchen_light', 'light.kitchen_main', { category: 'system' });
        db.setKey('job:weather:last_run', '2026-09-17', {});
        db.setKey('notified_backup_done', '1', {});
        db.setKey('system_web_navigator_state', 'x', {});

        const index = db.getFactsIndex();
        expect(index.text).toContain('USER PROFILE');
        expect(index.text).toContain('- user_home_city: Springfield');
        expect(index.text).toContain('- relationship_sister_name: Ada');
        expect(index.text).toContain('AGENT NOTES');
        expect(index.text).toContain('- device_kitchen_light: light.kitchen_main');
        expect(index.text).not.toContain('job:weather');
        expect(index.text).not.toContain('notified_backup_done');
        expect(index.text).not.toContain('system_web_navigator_state');
        expect(index).toMatchObject({ shown: 3, total: 6, hidden: 3 });
        expect(index.text).toContain('+3 more facts');
    });

    test('a fact written for one day drops out after five', () => {
        const today = new Date().toISOString().slice(0, 10);
        db.setKey(`dentist_on_${today}`, 'at 10', {});
        db.setKey('trip_on_2020-01-01', 'old', {});
        const index = db.getFactsIndex();
        expect(index.text).toContain(`dentist_on_${today}`);
        expect(index.text).not.toContain('trip_on_2020-01-01');
    });

    test('long values become one line, and a written summary wins', () => {
        db.setKey('user_long_story', 'y'.repeat(400), {});
        db.setKey('user_with_summary', 'y'.repeat(400), { summary: 'the short version' });
        const index = db.getFactsIndex();
        const lines = index.text.split('\n').filter(l => l.startsWith('- '));
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
        expect(index.text).toContain('- user_with_summary: the short version');
        expect(index.text).toContain('…');
    });

    test('the budget caps the block, pinned facts stay, and the rest are counted', () => {
        for (let i = 0; i < 200; i++) db.setKey(`user_fact_${String(i).padStart(3, '0')}`, `value number ${i}`, {});
        db.setKey('user_pinned_one', 'keep me', {});
        db.toggleFactPin('user_pinned_one', 1);

        const index = db.getFactsIndex({ profileChars: 600, notesChars: 200 });
        expect(index.chars).toBeLessThan(1200);
        expect(index.text).toContain('- user_pinned_one: keep me');
        expect(index.shown).toBeLessThan(index.total);
        expect(index.hidden).toBeGreaterThan(100);
        expect(index.text).toMatch(/\+\d+ more facts/);
    });

    test('the same facts give the same block, so the cached prefix survives', () => {
        db.setKey('user_a', 'one', {});
        db.setKey('note_thing', 'two', { category: 'system' });
        expect(db.getFactsIndex().text).toBe(db.getFactsIndex().text);
    });

    test('a fact the owner asked for rises in the list', () => {
        for (let i = 0; i < 10; i++) db.setKey(`user_x_${i}`, `v${i}`, {});
        db.touchFacts('user_x_0');
        const first = db.getFactsIndex().text.split('\n').find(l => l.startsWith('- '));
        expect(first).toBe('- user_x_0: v0');
        expect(db.getFact('user_x_0').use_count).toBe(1);
    });

    test('an empty memory gives an empty block', () => {
        expect(db.getFactsIndex()).toMatchObject({ text: '', shown: 0, total: 0 });
    });
});

describe('finding a fact that is not in the list', () => {
    let dir, db, spies;

    beforeEach(() => {
        ({ dir, db } = tempDb());
        spies = ['log', 'warn'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
        db.setKey('user_home_city', 'Springfield', {});
        db.setKey('user_home_address', '12 Elm Street', {});
        db.setKey('work_client_acme_contact', 'Ada', { category: 'work' });
    });

    afterEach(() => {
        spies.forEach(s => s.mockRestore());
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('findFacts matches the key, then the value', () => {
        expect(db.findFacts('user_home_city').map(f => f.key)).toEqual(['user_home_city']);
        expect(db.findFacts('home').map(f => f.key).sort()).toEqual(['user_home_address', 'user_home_city']);
        expect(db.findFacts('elm').map(f => f.key)).toEqual(['user_home_address']);
        expect(db.findFacts('')).toEqual([]);
    });

    test('getFact answers with the value, and with near keys on a miss', async () => {
        await expect(runTool(db, 'getFact', { key: 'user_home_city' })).resolves.toEqual({ value: 'Springfield' });
        const near = await runTool(db, 'getFact', { key: 'home' });
        expect(near.info).toMatch(/Closest keys/);
        expect(near.info).toContain('user_home_address');
        const one = await runTool(db, 'getFact', { key: 'acme' });
        expect(one).toMatchObject({ key: 'work_client_acme_contact', value: 'Ada' });
        await expect(runTool(db, 'getFact', { key: 'nothing_like_this' })).resolves.toMatchObject({ info: expect.stringMatching(/nothing close/) });
    });

    test('rememberFact stores the kind and the summary it was given', async () => {
        await runTool(db, 'rememberFact', { key: 'user_coffee', value: 'black', kind: 'profile', summary: 'black, no sugar' });
        const row = db.getFact('user_coffee');
        expect(row).toMatchObject({ kind: 'profile', summary: 'black, no sugar' });
        expect(db.getFactsIndex().text).toContain('- user_coffee: black, no sugar');
    });

    test('updateFact corrects one match and refuses several', async () => {
        await expect(runTool(db, 'updateFact', { key: 'user_home_city', value: 'Shelbyville' }))
            .resolves.toMatchObject({ success: true, key: 'user_home_city' });
        expect(db.getKey('user_home_city')).toBe('Shelbyville');

        const many = await runTool(db, 'updateFact', { key: 'home', value: 'x' });
        expect(many.candidates.sort()).toEqual(['user_home_address', 'user_home_city']);
        expect(db.getKey('user_home_address')).toBe('12 Elm Street');

        const none = await runTool(db, 'updateFact', { key: 'nothing_like_this', value: 'x' });
        expect(none.error).toMatch(/No fact matches/);
    });

    test('forgetFact protects the owner\'s own facts and pinned ones until he asks', async () => {
        const guarded = await runTool(db, 'forgetFact', { key: 'user_home_city' });
        expect(guarded.error).toMatch(/durable fact about the owner/);
        expect(db.getKey('user_home_city')).toBe('Springfield');

        await expect(runTool(db, 'forgetFact', { key: 'user_home_city', force: true })).resolves.toMatchObject({ success: true });
        expect(db.getKey('user_home_city')).toBeNull();

        db.setKey('device_lamp', 'light.lamp', { category: 'system' });
        await expect(runTool(db, 'forgetFact', { key: 'device_lamp' })).resolves.toMatchObject({ success: true });

        db.setKey('note_pinned', 'x', { category: 'system' });
        db.toggleFactPin('note_pinned', 1);
        const pinned = await runTool(db, 'forgetFact', { key: 'note_pinned' });
        expect(pinned.error).toMatch(/pinned/);
    });

    test('searchMemory returns facts beside chats and documents', async () => {
        const services = { db, client: null, journal: { log: jest.fn() }, agent: {} };
        const executor = new MemoryExecutor(services);
        const out = await executor.execute('searchMemory', { query: 'home' }, { message: { metadata: {} } }, services);
        expect(out.facts.map(f => f.key).sort()).toEqual(['user_home_address', 'user_home_city']);
        expect(out).toHaveProperty('chat_history');
        expect(db.getFact('user_home_city').use_count).toBe(1);
    });
});
