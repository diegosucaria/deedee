/**
 * The nightly scan only ever added. A file deleted from a vault kept its
 * chunks, so search went on quoting a document that was gone — the pruning
 * specs/032 asked for at line 37. Real SQLite, real files, only the
 * embedding call is faked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RagService } = require('../src/services/rag-service');

const DIMS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;
const BODY = 'A document about generic topics, long enough for several chunks. '.repeat(120);

describe('the nightly scan drops files that are gone', () => {
    let root, vaultsDir, journalDir, rag, agent;

    const write = (file, body = BODY) => { fs.writeFileSync(file, body); return file; };
    const rowsFor = (name) => rag.db.prepare('SELECT id FROM documents WHERE filename = ?').all(name);
    const chunkCount = () => rag.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    const ftsCount = () => rag.db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n;
    const vecCount = () => (rag.useVec ? rag.db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get().n : null);

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-rag-prune-'));
        process.env.DATA_DIR = root;
        delete process.env.RAG_PRUNE_MISSING;
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });

        vaultsDir = path.join(root, 'vaults');
        journalDir = path.join(root, 'journal');
        fs.mkdirSync(path.join(vaultsDir, 'notes', 'files'), { recursive: true });
        fs.mkdirSync(journalDir, { recursive: true });

        agent = {
            client: { models: { embedContent: async () => ({ embeddings: [{ values: new Array(DIMS).fill(0.5) }] }) } },
            interface: { broadcast: jest.fn().mockResolvedValue() }
        };
        rag = new RagService(agent);
    });

    afterEach(() => {
        try { rag.db.close(); } catch { }
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
        delete process.env.RAG_PRUNE_MISSING;
    });

    test('a deleted file loses its chunks, its FTS rows and its vectors', async () => {
        write(path.join(vaultsDir, 'notes', 'files', 'keep.txt'));
        const gone = write(path.join(vaultsDir, 'notes', 'files', 'gone.txt'));
        await rag.scanAndIngest(vaultsDir);

        const before = { chunks: chunkCount(), fts: ftsCount(), vec: vecCount() };
        expect(rowsFor('gone.txt')).toHaveLength(1);
        expect(before.chunks).toBeGreaterThan(2);

        fs.unlinkSync(gone);
        await rag.scanAndIngest(vaultsDir);

        expect(rowsFor('gone.txt')).toHaveLength(0);
        expect(rowsFor('keep.txt')).toHaveLength(1);
        expect(chunkCount()).toBeLessThan(before.chunks);
        expect(ftsCount()).toBeLessThan(before.fts);
        // vec0 only holds rows where the extension loaded and took them.
        if (before.vec) expect(vecCount()).toBeLessThan(before.vec);
        // Nothing of the deleted file is left anywhere.
        const orphans = rag.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)').get().n;
        expect(orphans).toBe(0);
    });

    test('a deleted vault page goes too, not only a file', async () => {
        const page = write(path.join(vaultsDir, 'notes', 'old-review.md'));
        write(path.join(vaultsDir, 'notes', 'index.md'));
        await rag.scanAndIngest(vaultsDir);
        expect(rowsFor('old-review.md')).toHaveLength(1);

        fs.unlinkSync(page);
        await rag.scanAndIngest(vaultsDir);
        expect(rowsFor('old-review.md')).toHaveLength(0);
        expect(rowsFor('index.md')).toHaveLength(1);
    });

    test('the journal scan prunes a deleted day', async () => {
        const day = write(path.join(journalDir, '2026-09-20.md'));
        write(path.join(journalDir, '2026-09-21.md'));
        await rag.scanJournals(journalDir);
        expect(rowsFor('2026-09-20.md')).toHaveLength(1);

        fs.unlinkSync(day);
        await rag.scanJournals(journalDir);
        expect(rowsFor('2026-09-20.md')).toHaveLength(0);
        expect(rowsFor('2026-09-21.md')).toHaveLength(1);
    });

    test('a vault scan never prunes the journal, and the other way round', async () => {
        write(path.join(vaultsDir, 'notes', 'files', 'a.txt'));
        const day = write(path.join(journalDir, '2026-09-20.md'));
        await rag.scanAndIngest(vaultsDir);
        await rag.scanJournals(journalDir);

        fs.unlinkSync(day);
        await rag.scanAndIngest(vaultsDir); // vaults only
        expect(rowsFor('2026-09-20.md')).toHaveLength(1);
    });

    test('an unmounted data volume prunes nothing', async () => {
        write(path.join(vaultsDir, 'notes', 'files', 'a.txt'));
        await rag.scanAndIngest(vaultsDir);
        const before = chunkCount();

        // The whole tree is gone, the way a missing volume looks.
        fs.rmSync(vaultsDir, { recursive: true, force: true });
        expect(rag.pruneMissingDocuments([vaultsDir])).toBe(0);
        await rag.scanAndIngest(vaultsDir);

        expect(rowsFor('a.txt')).toHaveLength(1);
        expect(chunkCount()).toBe(before);
    });

    test('RAG_PRUNE_MISSING=0 leaves the old behaviour', async () => {
        const gone = write(path.join(vaultsDir, 'notes', 'files', 'gone.txt'));
        await rag.scanAndIngest(vaultsDir);
        fs.unlinkSync(gone);

        process.env.RAG_PRUNE_MISSING = '0';
        await rag.scanAndIngest(vaultsDir);
        expect(rowsFor('gone.txt')).toHaveLength(1);

        // Read on every call: turning it back on prunes at the next scan.
        process.env.RAG_PRUNE_MISSING = '1';
        await rag.scanAndIngest(vaultsDir);
        expect(rowsFor('gone.txt')).toHaveLength(0);
    });
});
