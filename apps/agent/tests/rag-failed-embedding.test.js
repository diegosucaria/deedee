/**
 * A document whose embedding failed used to be indexed for good: the
 * documents row was written with the file's hash before the embedding, and
 * the next scan took the matching hash for "already indexed". The file then
 * never got a vector. A failed pass now clears the hash, the next scan
 * indexes the file again, the chunks that worked stay until the new set is
 * complete, and after three failed passes in a row the owner hears once.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RagService } = require('../src/services/rag-service');

const DIMS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

describe('a failed embedding is not permanent', () => {
    let root, file, agent, opened, mode, calls;
    // 'ok' embeds everything; 'fail-all' fails every call; 'fail-third' fails the third call of a pass.
    const fakeEmbed = jest.fn(async () => {
        calls++;
        if (mode === 'fail-all' || (mode === 'fail-third' && calls === 3)) throw new Error('embedding service down');
        return { embeddings: [{ values: new Array(DIMS).fill(0.5) }] };
    });
    const open = () => {
        const rag = new RagService(agent);
        rag.embedRetries = 1;
        rag.embedRetryBaseMs = 1;
        opened.push(rag);
        return rag;
    };
    const docRow = (rag, f = file) => rag.db.prepare('SELECT hash, failed_attempts FROM documents WHERE filepath = ?').get(f);
    const chunksOf = (rag, f = file) => rag.db.prepare('SELECT COUNT(*) AS n FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.filepath = ? AND c.embedding IS NOT NULL').get(f).n;
    const pass = (rag, m, f = file) => { mode = m; calls = 0; return rag.ingestDocument(f, 'notes'); };

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-rag-failed-'));
        process.env.DATA_DIR = root;
        fs.mkdirSync(path.join(root, 'vaults', 'notes', 'files'), { recursive: true });
        file = path.join(root, 'vaults', 'notes', 'files', 'a.txt');
        // Long enough for several 2,000-character chunks.
        fs.writeFileSync(file, 'A document about generic topics, long enough to embed in several chunks. '.repeat(160));
    });
    beforeEach(() => {
        opened = [];
        mode = 'ok';
        calls = 0;
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
        const first = await pass(rag, 'fail-all');
        expect(first.failed).toBeGreaterThan(0);
        expect(chunksOf(rag)).toBe(0);
        expect(docRow(rag)).toEqual({ hash: null, failed_attempts: 1 });

        const second = await pass(rag, 'ok');
        expect(second.failed).toBe(0);
        expect(chunksOf(rag)).toBeGreaterThan(1);
        expect(docRow(rag)).toEqual({ hash: expect.any(String), failed_attempts: 0 });
    });

    test('the chunks that worked stay until the new set is complete: a bad night never empties a document', async () => {
        const rag = open();
        const first = await pass(rag, 'fail-third');
        expect(first.failed).toBe(1);
        const partial = chunksOf(rag);
        expect(partial).toBeGreaterThan(1);
        expect(docRow(rag).hash).toBeNull();

        // Night two: the service is down. What was searchable stays searchable.
        const second = await pass(rag, 'fail-all');
        expect(second.failed).toBeGreaterThan(0);
        expect(chunksOf(rag)).toBe(partial);
        expect(docRow(rag)).toEqual({ hash: null, failed_attempts: 2 });

        // Night three: all good. The complete set replaces the partial one.
        await pass(rag, 'ok');
        expect(chunksOf(rag)).toBe(partial + 1);
        expect(docRow(rag).failed_attempts).toBe(0);
    });

    test('a pass that throws counts as failed too, and the file is tried again', async () => {
        const bad = path.join(root, 'vaults', 'notes', 'files', 'bad.pdf');
        fs.writeFileSync(bad, 'this is not a pdf');
        const rag = open();
        await expect(pass(rag, 'ok', bad)).rejects.toThrow();
        expect(docRow(rag, bad)).toEqual({ hash: null, failed_attempts: 1 });
        // The next scan does not take it for indexed: it tries, and fails, again.
        await expect(pass(rag, 'ok', bad)).rejects.toThrow();
        expect(docRow(rag, bad).failed_attempts).toBe(2);
    });

    test('after three failed passes in a row the scan stops trying and the owner hears once', async () => {
        const rag = open();
        await pass(rag, 'fail-all');
        await pass(rag, 'fail-all');
        expect(agent.notifications.create).not.toHaveBeenCalled();
        await pass(rag, 'fail-all');
        expect(docRow(rag)).toEqual({ hash: expect.any(String), failed_attempts: 3 });
        expect(agent.notifications.create).toHaveBeenCalledTimes(1);
        expect(agent.notifications.create.mock.calls[0][0]).toMatchObject({ type: 'rag_ingest_failed', metadata: { filename: 'a.txt', attempts: 3 } });

        // The next scan skips it: no embedding call, no second notification.
        fakeEmbed.mockClear();
        await pass(rag, 'ok');
        expect(fakeEmbed).not.toHaveBeenCalled();
        expect(agent.notifications.create).toHaveBeenCalledTimes(1);
    });

    test('a file that was indexed is still skipped on the next scan', async () => {
        const rag = open();
        await pass(rag, 'ok');
        const n = fakeEmbed.mock.calls.length;
        expect(n).toBeGreaterThan(0);
        await pass(rag, 'ok');
        expect(fakeEmbed.mock.calls.length).toBe(n);
    });
});
