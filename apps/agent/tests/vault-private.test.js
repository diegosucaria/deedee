/**
 * searchMemory runs on every turn and searched every vault at once, the
 * owner's medical one included. A vault marked private now stays out of a
 * search over everything. Naming the vault still reaches it, so a chat
 * opened on that vault works as before.
 *
 * Real AgentDB, real RagService, real SQLite; only the embedding call is
 * faked, and each vault gets its own vector so ranking is real.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { RagService } = require('../src/services/rag-service');
const { MemoryExecutor } = require('../src/executors/memory');

const DIMS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

// One direction per vault, so a query aimed at one vault scores it highest
// and the others still clear minScore only if they are searched at all.
const DIRECTIONS = {
    health: 0,
    finance: 1,
    journal: 2
};

function vectorFor(text) {
    const values = new Array(DIMS).fill(0);
    let slot = DIRECTIONS.journal;
    for (const [vault, index] of Object.entries(DIRECTIONS)) {
        if (text.toLowerCase().includes(vault)) slot = index;
    }
    values[slot] = 1;
    return values;
}

describe('a private vault stays out of the search that runs on every turn', () => {
    let root, db, rag, agent;

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-vault-private-'));
        process.env.DATA_DIR = root;
        delete process.env.VAULT_PRIVACY;
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });

        db = new AgentDB(root);
        agent = {
            db,
            client: {
                models: {
                    embedContent: async ({ contents }) => {
                        const text = contents?.[0]?.parts?.[0]?.text || '';
                        return { embeddings: [{ values: vectorFor(text) }] };
                    }
                }
            }
        };
        rag = new RagService(agent);
        agent.ragService = rag;

        for (const vault of Object.keys(DIRECTIONS)) {
            const file = path.join(root, `${vault}.md`);
            fs.writeFileSync(file, `Notes about ${vault} and what happened there.`);
            await rag.ingestDocument(file, vault);
        }
    });

    afterEach(() => {
        try { rag.db.close(); } catch { }
        try { db.close(); } catch { }
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
        delete process.env.VAULT_PRIVACY;
    });

    const vaultsIn = (results) => results.map(r => r.vault_id);

    test("a question asked in the private vault's own chat pane stays out of the chat search too", async () => {
        db.setVaultPrivate('health', true);
        db.saveMessage({ role: 'user', content: 'what did the scan say about my knee', chatId: 'vault-health', source: 'web' });
        db.saveMessage({ role: 'model', content: 'the scan report says the knee is fine', chatId: 'vault-health', source: 'web' });
        db.saveMessage({ role: 'user', content: 'the printer scan is done', chatId: 'web-1', source: 'web' });

        const rows = db.searchMessages('scan', 10, { notChatIds: ['vault-health'] });
        expect(rows.map(r => r.chat_id)).toEqual(['web-1']);

        const executor = new MemoryExecutor({ db, agent });
        const out = JSON.stringify(await executor.execute('searchMemory', { query: 'scan' }, { message: { metadata: {} } }));
        expect(out).toContain('printer scan');
        expect(out).not.toContain('knee');

        // Not private: the pane's rows are ordinary chat rows again.
        db.setVaultPrivate('health', false);
        const open = JSON.stringify(await executor.execute('searchMemory', { query: 'scan' }, { message: { metadata: {} } }));
        expect(open).toContain('knee');
    });

    test('with nothing marked private the search reads every vault, as before', async () => {
        const results = await rag.search('health', null, 10, 0);
        expect(vaultsIn(results)).toEqual(expect.arrayContaining(['health', 'finance', 'journal']));
    });

    test('a search over everything skips the private vault', async () => {
        db.setVaultPrivate('health', true);
        const results = await rag.search('health', null, 10, 0);
        expect(vaultsIn(results)).not.toContain('health');
        expect(vaultsIn(results)).toEqual(expect.arrayContaining(['finance', 'journal']));
    });

    test('naming the vault still searches it: a chat opened on that vault works', async () => {
        db.setVaultPrivate('health', true);
        const results = await rag.search('health', 'health', 10, 0);
        expect(vaultsIn(results)).toEqual(['health']);
    });

    test('searchMemory, which runs on every turn, no longer reads it', async () => {
        db.setVaultPrivate('health', true);
        const executor = new MemoryExecutor({ db, agent, client: agent.client });
        const answer = await executor.execute('searchMemory', { query: 'health', limit: 10 }, { metadata: {} });
        expect(answer.knowledge.map(k => k.source)).not.toContain('RAG:health');
    });

    test('taking the mark off puts the vault back in the search', async () => {
        db.setVaultPrivate('health', true);
        expect(vaultsIn(await rag.search('health', null, 10, 0))).not.toContain('health');
        db.setVaultPrivate('health', false);
        expect(vaultsIn(await rag.search('health', null, 10, 0))).toContain('health');
    });

    test('a document with no vault is never dropped by the skip', async () => {
        const loose = path.join(root, 'loose.md');
        fs.writeFileSync(loose, 'Notes about journal matters with no vault.');
        await rag.ingestDocument(loose, null);
        db.setVaultPrivate('health', true);

        const results = await rag.search('journal', null, 10, 0);
        expect(results.some(r => r.filename === 'loose.md')).toBe(true);
    });

    test('VAULT_PRIVACY=0 goes back to searching everything', async () => {
        db.setVaultPrivate('health', true);
        process.env.VAULT_PRIVACY = '0';
        expect(vaultsIn(await rag.search('health', null, 10, 0))).toContain('health');
        // Read on every call, so turning it back on takes effect at once.
        process.env.VAULT_PRIVACY = '1';
        expect(vaultsIn(await rag.search('health', null, 10, 0))).not.toContain('health');
    });

    test('the flag survives a restart and defaults to off', () => {
        expect(db.isVaultPrivate('health')).toBe(false);
        db.setVaultPrivate('health', true);
        db.close();

        const again = new AgentDB(root);
        expect(again.isVaultPrivate('health')).toBe(true);
        expect(again.isVaultPrivate('finance')).toBe(false);
        expect(again.getPrivateVaultIds()).toEqual(['health']);
        again.close();
        db = again;
    });
});
