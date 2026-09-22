/**
 * A document whose embedding failed used to be indexed for good: the
 * documents row was written with the file's hash before the embedding, and
 * the next scan took the matching hash for "already indexed". The file then
 * never got a vector. A failed embedding now clears the hash, and the next
 * scan indexes the file again.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RagService } = require('../src/services/rag-service');

const DIMS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

describe('a failed embedding is not permanent', () => {
    let root, file, agent, opened, embedFails;
    const fakeEmbed = jest.fn(async () => {
        if (embedFails) throw new Error('embedding service down');
        return { embeddings: [{ values: new Array(DIMS).fill(0.5) }] };
    });
    const open = () => {
        const rag = new RagService(agent);
        rag.embedRetries = 1;
        rag.embedRetryBaseMs = 1;
        opened.push(rag);
        return rag;
    };
    const docRow = (rag) => rag.db.prepare('SELECT hash FROM documents WHERE filepath = ?').get(file);
    const embeddedChunks = (rag) => rag.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get().n;

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-rag-failed-'));
        process.env.DATA_DIR = root;
        fs.mkdirSync(path.join(root, 'vaults', 'notes', 'files'), { recursive: true });
        file = path.join(root, 'vaults', 'notes', 'files', 'a.txt');
        fs.writeFileSync(file, 'A document about generic topics, long enough to embed. '.repeat(20));
    });
    beforeEach(() => {
        opened = [];
        embedFails = false;
        fakeEmbed.mockClear();
        agent = { client: { models: { embedContent: fakeEmbed } }, interface: { broadcast: jest.fn().mockResolvedValue() }, notifications: { create: jest.fn() } };
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });
    afterEach(() => {
        jest.restoreAllMocks();
        for (const rag of opened) { try { rag.db.close(); } catch { } }
        try { fs.unlinkSync(path.join(root, 'rag.db')); } catch { }
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    test('the file is indexed again on the next scan once the embedding works', async () => {
        const rag = open();
        embedFails = true;
        const first = await rag.ingestDocument(file, 'notes');
        expect(first.failed).toBeGreaterThan(0);
        expect(embeddedChunks(rag)).toBe(0);
        // The row stays, but without the hash that would mark it as done.
        expect(docRow(rag).hash).toBeNull();

        embedFails = false;
        fakeEmbed.mockClear();
        const second = await rag.ingestDocument(file, 'notes');
        expect(second.failed).toBe(0);
        expect(fakeEmbed).toHaveBeenCalled();
        expect(embeddedChunks(rag)).toBeGreaterThan(0);
        expect(docRow(rag).hash).toEqual(expect.any(String));
    });

    test('a file that was indexed is still skipped on the next scan', async () => {
        const rag = open();
        await rag.ingestDocument(file, 'notes');
        const calls = fakeEmbed.mock.calls.length;
        expect(calls).toBeGreaterThan(0);
        await rag.ingestDocument(file, 'notes');
        expect(fakeEmbed.mock.calls.length).toBe(calls);
    });
});
