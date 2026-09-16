const fs = require('fs');
const os = require('os');
const path = require('path');

// Controllable embedding model id. The real ConfigService reads env at load time.
jest.mock('../src/services/config-service', () => {
    let model = 'embed-model-a';
    return {
        ConfigService: class {
            getModel(type) { return type === 'EMBEDDING' ? model : 'mock-model'; }
            logUsageFromResponse() { return { cost: 0, tokens: 0 }; }
        },
        __setEmbeddingModel(m) { model = m; }
    };
});

const { RagService } = require('../src/services/rag-service');
const { __setEmbeddingModel } = require('../src/services/config-service');

const DIMS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

describe('RAG re-embed on embedding model change', () => {
    let root, vaultsDir, embedCalls, agent, opened;

    // Default fake: records the model id, returns a constant vector.
    const defaultEmbed = async ({ model }) => {
        embedCalls.push(model);
        return { embeddings: [{ values: new Array(DIMS).fill(0.5) }] };
    };
    const fakeEmbed = jest.fn(defaultEmbed);

    const open = () => {
        const rag = new RagService(agent);
        rag.embedRetryBaseMs = 1; // keep the backoff out of the test clock
        opened.push(rag);
        return rag;
    };
    const metaModel = (rag) => rag.db.prepare("SELECT value FROM rag_metadata WHERE key = 'embedding_model'").get()?.value;
    const embeddedChunks = (rag) => rag.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get().n;
    const ftsRows = (rag) => rag.db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n;
    const chunkText = ({ contents }) => contents?.[0]?.parts?.[0]?.text || '';

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-rag-reembed-'));
        process.env.DATA_DIR = root; // RagService opens $DATA_DIR/rag.db
        vaultsDir = path.join(root, 'vaults');
        fs.mkdirSync(path.join(vaultsDir, 'notes', 'files'), { recursive: true });
        fs.writeFileSync(path.join(vaultsDir, 'notes', 'files', 'a.txt'), 'Alpha document about generic topics. '.repeat(20));
        fs.writeFileSync(path.join(vaultsDir, 'notes', 'index.md'), '# Notes\n\nA vault index page with enough text to embed.');
    });

    beforeEach(() => {
        embedCalls = [];
        opened = [];
        fakeEmbed.mockReset();
        fakeEmbed.mockImplementation(defaultEmbed);
        agent = {
            client: { models: { embedContent: fakeEmbed } },
            interface: { broadcast: jest.fn().mockResolvedValue() },
            notifications: { create: jest.fn() }
        };
    });

    afterEach(() => {
        for (const rag of opened) { try { rag.db.close(); } catch (e) { } }
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('first index records the embedding model id', async () => {
        __setEmbeddingModel('embed-model-a');
        const rag = open();
        expect(rag.pendingModelReembed).toBeNull();
        await rag.scanAndIngest(vaultsDir);
        expect(embeddedChunks(rag)).toBeGreaterThan(0);
        expect(metaModel(rag)).toBe('embed-model-a');
        expect(embedCalls.every(m => m === 'embed-model-a')).toBe(true);
    });

    test('same model on the next start: nothing pending, no notification', () => {
        __setEmbeddingModel('embed-model-a');
        const rag = open();
        expect(rag.pendingModelReembed).toBeNull();
        expect(rag.startPendingReembed(vaultsDir, null)).toBeNull();
        expect(agent.notifications.create).not.toHaveBeenCalled();
    });

    test('new model id with same dimensions: keeps old vectors, queues a re-embed', () => {
        __setEmbeddingModel('embed-model-b');
        const rag = open();
        expect(rag.pendingModelReembed).toEqual({ prevModel: 'embed-model-a', currentModel: 'embed-model-b', dims: DIMS });
        expect(rag.needsReindex).toBe(false);
        expect(embeddedChunks(rag)).toBeGreaterThan(0); // not cleared at boot
        expect(metaModel(rag)).toBe('embed-model-a'); // old id kept until re-embed completes
        // Constructor must not notify: agent.notifications does not exist yet at that point.
        expect(agent.notifications.create).not.toHaveBeenCalled();
    });

    test('startPendingReembed notifies, re-embeds everything with the new model, records it', async () => {
        __setEmbeddingModel('embed-model-b');
        const rag = open();
        const before = embeddedChunks(rag);
        const ftsBefore = ftsRows(rag);

        const task = rag.startPendingReembed(vaultsDir, null);
        expect(task).toBeInstanceOf(Promise);
        expect(rag.reembedInProgress).toBe(true);
        expect(agent.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
            type: 'rag_reindex_required',
            severity: 'warning',
            title: 'RAG index needs re-embedding for model embed-model-b',
            metadata: expect.objectContaining({ prevModel: 'embed-model-a', currentModel: 'embed-model-b', dims: DIMS })
        }));
        // A second call while running is a no-op.
        expect(rag.startPendingReembed(vaultsDir, null)).toBeNull();

        await expect(task).resolves.toBe(true);
        expect(rag.reembedInProgress).toBe(false);
        expect(rag.pendingModelReembed).toBeNull();
        expect(metaModel(rag)).toBe('embed-model-b');
        expect(embedCalls.length).toBeGreaterThan(0);
        expect(embedCalls.every(m => m === 'embed-model-b')).toBe(true);
        expect(embeddedChunks(rag)).toBe(before);
        expect(ftsRows(rag)).toBe(ftsBefore); // no duplicate or lost keyword rows
        expect(rag.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE hash = ''").get().n).toBe(0);
        expect(agent.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
            type: 'rag_reindex_complete', severity: 'info'
        }));
        // Nothing left to do.
        expect(rag.startPendingReembed(vaultsDir, null)).toBeNull();
    });

    test('reindexAll also re-ingests documents that live outside the vaults', async () => {
        __setEmbeddingModel('embed-model-b');
        const rag = open();
        const memoryFile = path.join(root, 'memory.md');
        fs.writeFileSync(memoryFile, 'Durable memory file, ingested directly rather than by a vault scan.');
        await rag.ingestDocument(memoryFile, 'memory');
        embedCalls = [];

        const counts = await rag.reindexAll(vaultsDir, null);
        expect(counts).toMatchObject({ documents: 3, reembedded: 3, failedDocuments: 0, failedChunks: 0, missing: 0, complete: true });
        const row = rag.db.prepare('SELECT hash FROM documents WHERE filepath = ?').get(memoryFile);
        expect(row.hash).not.toBe('');
        expect(embedCalls.length).toBeGreaterThan(0);
    });

    test('an embedding call that fails once is retried and the run completes', async () => {
        __setEmbeddingModel('embed-model-r');
        const rag = open();
        expect(rag.pendingModelReembed.currentModel).toBe('embed-model-r');
        fakeEmbed.mockImplementationOnce(() => Promise.reject(new Error('429 quota')));
        const chunksBefore = rag.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;

        await expect(rag.startPendingReembed(vaultsDir, null)).resolves.toBe(true);
        expect(metaModel(rag)).toBe('embed-model-r');
        expect(rag.pendingModelReembed).toBeNull();
        // One extra call for the retry, no chunk lost.
        expect(fakeEmbed.mock.calls.length).toBe(chunksBefore + 1);
        expect(rag.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n).toBe(chunksBefore);
        expect(agent.notifications.create).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rag_reindex_failed' }));
    });

    test('a chunk that keeps failing keeps its old vector, the old model id stays, failure notified with counts', async () => {
        __setEmbeddingModel('embed-model-f');
        const rag = open();
        const aPath = path.join(vaultsDir, 'notes', 'files', 'a.txt');
        const aDoc = rag.db.prepare('SELECT id FROM documents WHERE filepath = ?').get(aPath);
        const before = rag.db.prepare('SELECT id, embedding FROM chunks WHERE document_id = ? ORDER BY chunk_index').all(aDoc.id);
        const chunksBefore = rag.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
        const ftsBefore = ftsRows(rag);

        // Every call for the Alpha document fails; everything else embeds to a new value.
        fakeEmbed.mockImplementation(async (req) => {
            embedCalls.push(req.model);
            if (chunkText(req).startsWith('Alpha')) throw new Error('429 quota');
            return { embeddings: [{ values: new Array(DIMS).fill(0.25) }] };
        });

        await expect(rag.startPendingReembed(vaultsDir, null)).resolves.toBe(false);

        // 3 tries for the failing chunk.
        expect(embedCalls.filter(() => true).length).toBe(chunksBefore - before.length + before.length * 3);
        // The failing document kept its rows, vectors and keyword entries.
        const after = rag.db.prepare('SELECT id, embedding FROM chunks WHERE document_id = ? ORDER BY chunk_index').all(aDoc.id);
        expect(after.map(r => r.id)).toEqual(before.map(r => r.id));
        expect(after.every((r, i) => r.embedding.equals(before[i].embedding))).toBe(true);
        expect(rag.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n).toBe(chunksBefore);
        expect(ftsRows(rag)).toBe(ftsBefore);
        // The other documents did move to the new vectors.
        const other = rag.db.prepare('SELECT embedding FROM chunks WHERE document_id != ? LIMIT 1').get(aDoc.id);
        expect(new Float32Array(other.embedding.buffer, other.embedding.byteOffset, 1)[0]).toBeCloseTo(0.25);
        // Old id stays so the next boot retries; failure carries the counts.
        expect(metaModel(rag)).toBe('embed-model-r');
        expect(rag.pendingModelReembed.currentModel).toBe('embed-model-f');
        expect(rag.reembedInProgress).toBe(false);
        expect(agent.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
            type: 'rag_reindex_failed', severity: 'error',
            metadata: expect.objectContaining({ documents: 3, reembedded: 2, failedDocuments: 1, failedChunks: 1, currentModel: 'embed-model-f' })
        }));
        expect(agent.notifications.create).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rag_reindex_complete' }));
    });

    test('reindexAll runs once at a time; scans skip while it runs', async () => {
        __setEmbeddingModel('embed-model-f');
        const rag = open();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        fakeEmbed.mockImplementation(async (req) => { await gate; return defaultEmbed(req); });

        const p1 = rag.reindexAll(vaultsDir, null);
        const p2 = rag.reindexAll(vaultsDir, null);
        expect(p2).toBe(p1);
        expect(rag.reindexPromise).toBe(p1);

        const ingest = jest.spyOn(rag, 'ingestDocument');
        await rag.scanAndIngest(vaultsDir);
        await rag.scanJournals(root);
        expect(ingest).not.toHaveBeenCalled();
        ingest.mockRestore();

        release();
        const counts = await p1;
        expect(counts.complete).toBe(true);
        expect(rag.reindexPromise).toBeNull();
        expect(metaModel(rag)).toBe('embed-model-f');

        // Lock released: a scan runs again.
        const ingestAfter = jest.spyOn(rag, 'ingestDocument');
        await rag.scanAndIngest(vaultsDir);
        expect(ingestAfter).toHaveBeenCalled();
    });

    test('_embedTextChunks keeps at most embedConcurrency calls in flight and reports failures', async () => {
        __setEmbeddingModel('embed-model-f');
        const rag = open();
        rag.embedRetries = 1;
        let inFlight = 0, peak = 0;
        fakeEmbed.mockImplementation(async (req) => {
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 2));
            inFlight--;
            if (chunkText(req) === 'bad') throw new Error('boom');
            return { embeddings: [{ values: new Array(DIMS).fill(0.1) }] };
        });
        const info = rag.db.prepare("INSERT INTO documents (filepath, filename, hash, vault_id, indexed_at) VALUES ('/nowhere/x.txt', 'x.txt', 'h', 'v', 'now')").run();
        const chunks = ['c0', 'c1', 'bad', 'c3', 'c4', 'c5', 'c6', 'c7'];
        const failed = await rag._embedTextChunks(info.lastInsertRowid, chunks, 'text');
        expect(failed).toBe(1);
        expect(peak).toBeLessThanOrEqual(3);
        expect(peak).toBeGreaterThan(1);
        expect(rag.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?').get(info.lastInsertRowid).n).toBe(7);
        rag.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(info.lastInsertRowid);
        rag.db.prepare('DELETE FROM chunks_fts WHERE document_id = ?').run(info.lastInsertRowid);
        rag.db.prepare('DELETE FROM documents WHERE id = ?').run(info.lastInsertRowid);
    });

    test('a failed re-embed notifies with severity error and stays pending for the next start', async () => {
        __setEmbeddingModel('embed-model-c');
        const rag = open();
        expect(rag.pendingModelReembed.currentModel).toBe('embed-model-c');
        rag.reindexAll = jest.fn().mockRejectedValue(new Error('quota exceeded'));

        await expect(rag.startPendingReembed(vaultsDir, null)).resolves.toBe(false);
        expect(rag.pendingModelReembed.currentModel).toBe('embed-model-c');
        expect(rag.reembedInProgress).toBe(false);
        expect(metaModel(rag)).toBe('embed-model-f');
        expect(agent.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
            type: 'rag_reindex_failed', severity: 'error',
            metadata: expect.objectContaining({ error: 'quota exceeded' })
        }));
    });

    test('works without a notifications service', async () => {
        __setEmbeddingModel('embed-model-c');
        delete agent.notifications;
        const rag = open();
        await expect(rag.startPendingReembed(vaultsDir, null)).resolves.toBe(true);
        expect(metaModel(rag)).toBe('embed-model-c');
    });
});
