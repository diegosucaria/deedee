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

    const fakeEmbed = jest.fn(async ({ model }) => {
        embedCalls.push(model);
        return { embeddings: [{ values: new Array(DIMS).fill(0.5) }] };
    });

    const open = () => {
        const rag = new RagService(agent);
        opened.push(rag);
        return rag;
    };
    const metaModel = (rag) => rag.db.prepare("SELECT value FROM rag_metadata WHERE key = 'embedding_model'").get()?.value;
    const embeddedChunks = (rag) => rag.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get().n;

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

        await rag.reindexAll(vaultsDir, null);
        const row = rag.db.prepare('SELECT hash FROM documents WHERE filepath = ?').get(memoryFile);
        expect(row.hash).not.toBe('');
        expect(embedCalls.length).toBeGreaterThan(0);
    });

    test('a failed re-embed notifies with severity error and stays pending for the next start', async () => {
        __setEmbeddingModel('embed-model-c');
        const rag = open();
        expect(rag.pendingModelReembed.currentModel).toBe('embed-model-c');
        rag.reindexAll = jest.fn().mockRejectedValue(new Error('quota exceeded'));

        await expect(rag.startPendingReembed(vaultsDir, null)).resolves.toBe(false);
        expect(rag.pendingModelReembed.currentModel).toBe('embed-model-c');
        expect(rag.reembedInProgress).toBe(false);
        expect(metaModel(rag)).toBe('embed-model-b');
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
