/**
 * saveNoteToVault wrote the note to index.md and stopped there. addToVault
 * and writeVaultPage both index the page they touch, so a note saved with
 * this tool was the one kind of vault content searchDocuments could never
 * find. Real VaultManager, real RagService, real SQLite: only the embedding
 * call is faked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const VaultManager = require('../src/vault-manager');
const { RagService } = require('../src/services/rag-service');
const { VaultExecutor } = require('../src/executors/vault');

const DIMS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

describe('a note saved to a vault can be found again', () => {
    let root, vaults, rag, executor, agent;

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-vault-note-'));
        process.env.DATA_DIR = root;
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });

        vaults = new VaultManager(root);
        await vaults.initialize();
        agent = {
            client: { models: { embedContent: async () => ({ embeddings: [{ values: new Array(DIMS).fill(0.5) }] }) } },
            activeTopics: new Map()
        };
        rag = new RagService(agent);
        agent.ragService = rag;
        executor = new VaultExecutor({ vaults, agent });
    });

    afterEach(() => {
        try { rag.db.close(); } catch { }
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const indexedText = () => rag.db.prepare(`
        SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE d.vault_id = 'health'`).all().map(r => r.content).join('\n');

    test("a note saved to 'Health' is filed under the folder's name, so the private flag still covers it", async () => {
        await executor.execute('saveNoteToVault', { topic: 'Health', content: 'a note about the knee' }, { message: { metadata: {} } });
        const rows = rag.db.prepare('SELECT vault_id FROM documents').all();
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every(r => r.vault_id === 'health')).toBe(true);
    });

    test('saveNoteToVault indexes the page it wrote', async () => {
        await executor.execute('saveNoteToVault',
            { topic: 'health', content: 'The appointment is on the fourteenth.' },
            { metadata: { chatId: 'chat-1' } });

        const docs = rag.listDocuments('health');
        expect(docs.map(d => d.filename)).toContain('index.md');
        expect(docs.find(d => d.filename === 'index.md').chunk_count).toBeGreaterThan(0);
        expect(indexedText()).toContain('The appointment is on the fourteenth.');
    });

    test('a second note is indexed too, not only the first', async () => {
        const ctx = { metadata: { chatId: 'chat-1' } };
        await executor.execute('saveNoteToVault', { topic: 'health', content: 'First note.' }, ctx);
        await executor.execute('saveNoteToVault', { topic: 'health', content: 'Second note.' }, ctx);

        const text = indexedText();
        expect(text).toContain('First note.');
        expect(text).toContain('Second note.');
    });

    test('the note is saved even when the index is down', async () => {
        agent.client.models.embedContent = async () => { throw new Error('embedding service down'); };
        rag.embedRetries = 1;
        rag.embedRetryBaseMs = 1;

        const answer = await executor.execute('saveNoteToVault',
            { topic: 'health', content: 'Written while the index was down.' },
            { metadata: { chatId: 'chat-1' } });

        expect(answer).toContain("Note saved to 'health' vault.");
        const page = await vaults.readVaultPage('health', 'index.md');
        expect(page).toContain('Written while the index was down.');
    });

    test('the chat switches to the vault, so the next question searches it', async () => {
        await executor.execute('saveNoteToVault',
            { topic: 'health', content: 'A note.' },
            { metadata: { chatId: 'chat-1' } });
        expect(agent.activeTopics.get('chat-1')).toBe('health');
    });
});
