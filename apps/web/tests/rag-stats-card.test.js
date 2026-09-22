/**
 * The Knowledge Base card read `stats.rag.totalDocuments`. getStats() returns
 * `documents`, so the card always said 0 Docs, however full the index was.
 * This builds a real index in a temp folder and reads the card from its real
 * stats.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { knowledgeBaseValue, knowledgeBaseDetail } = require('../src/lib/rag-stats.js');

const PAGE = fs.readFileSync(path.join(__dirname, '../src/app/system/stats/page.js'), 'utf8');
const DIMS = parseInt(process.env.EMBEDDING_DIMENSIONS, 10) || 768;

describe('the Knowledge Base card', () => {
    let root, rag, oldDataDir;

    beforeAll(async () => {
        oldDataDir = process.env.DATA_DIR;
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-ragcard-'));
        process.env.DATA_DIR = root;
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });

        const { RagService } = require('../../agent/src/services/rag-service');
        const agent = {
            client: { models: { embedContent: async () => ({ embeddings: [{ values: new Array(DIMS).fill(0.5) }] }) } }
        };
        rag = new RagService(agent);
        const file = path.join(root, 'notes.md');
        fs.writeFileSync(file, 'A note about generic topics, long enough for several chunks. '.repeat(160));
        await rag.ingestDocument(file, 'notes');
    });

    afterAll(() => {
        try { rag.db.close(); } catch { }
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
        if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir;
    });

    test('the card counts the documents the index really holds', () => {
        const stats = rag.getStats();
        expect(stats.documents).toBe(1);
        expect(knowledgeBaseValue(stats)).toBe('1 Docs');
        expect(stats.totalDocuments).toBeUndefined();
    });

    test('the card shows the chunk count too', () => {
        const stats = rag.getStats();
        expect(stats.chunks).toBeGreaterThan(1);
        expect(knowledgeBaseDetail(stats)).toBe(`${stats.chunks} chunks`);
    });

    test('an empty index reads 0 Docs with no detail line', () => {
        expect(knowledgeBaseValue({ documents: 0, chunks: 0 })).toBe('0 Docs');
        expect(knowledgeBaseDetail({ documents: 0, chunks: 0 })).toBeNull();
        expect(knowledgeBaseValue(undefined)).toBe('0 Docs');
    });

    test('the page no longer reads the field that never existed', () => {
        expect(PAGE).not.toContain('totalDocuments');
        expect(PAGE).toContain('knowledgeBaseValue(stats.rag)');
    });
});
