
const { RagService } = require('../src/services/rag-service');
const { Agent } = require('../src/agent');
const path = require('path');
const fs = require('fs');

// Mock ConfigService
jest.mock('../src/services/config-service', () => {
    return {
        ConfigService: class {
            getModel(type) { return 'mock-model'; }
            logUsageFromResponse() { return { cost: 0, tokens: 0 }; }
        }
    };
});

describe('Hybrid Search (Vector + FTS5)', () => {
    let ragService;
    let agent;
    const testDbPath = path.join(__dirname, 'rag_test.db');

    // Mock Agent with minimal interface
    const mockAgent = {
        client: {
            models: {
                embedContent: jest.fn().mockResolvedValue({
                    embedding: { values: new Array(768).fill(0.1) }
                })
            }
        },
        interface: { broadcast: jest.fn() }
    };

    beforeAll(() => {
        // cleanup previous test db
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

        // Hijack process.cwd to point to a temp dir so we don't mess with real data
        ragService = new RagService(mockAgent);
        // Override dbPath for test
        ragService.dbPath = testDbPath;
        const Database = require('better-sqlite3');
        ragService.db = new Database(testDbPath);
        ragService._initDB();
    });

    afterAll(() => {
        if (ragService.db) ragService.db.close();
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    test('should create FTS5 virtual table', () => {
        const table = ragService.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'").get();
        expect(table).toBeDefined();
    });

    test('should ingest document and populate FTS index', async () => {
        const testFile = path.join(__dirname, 'test_doc.txt');
        fs.writeFileSync(testFile, 'The secret code is XJ-9-Omega.');

        // Mock embedding to be distinct for semantic query vs exact mock
        mockAgent.client.models.embedContent.mockResolvedValueOnce({
            embedding: { values: new Array(768).fill(0.1) } // document embedding
        });

        await ragService.ingestDocument(testFile, 'test_vault');

        // Verify Chunk exists in normal table
        const chunk = ragService.db.prepare('SELECT * FROM chunks').get();
        expect(chunk).toBeDefined();
        expect(chunk.content).toContain('XJ-9-Omega');

        // Verify FTS index
        const ftsCount = ragService.db.prepare('SELECT COUNT(*) as count FROM chunks_fts').get().count;
        expect(ftsCount).toBeGreaterThan(0);

        fs.unlinkSync(testFile);
    });

    test('should retrieve results via Keyword Search (FTS) even if semantic score is low', async () => {
        // We simulate a search. 
        // We mock the embedding for the QUERY to be somewhat different so vector score is not 1.0 (perfect)
        // But the keyword match should boost it.
        mockAgent.client.models.embedContent.mockResolvedValueOnce({
            embedding: { values: new Array(768).fill(0.05) } // Query embedding different from doc (0.1)
        });

        // The query "XJ-9-Omega" is very specific and distinct.
        const results = await ragService.search('XJ-9-Omega', 'test_vault');

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].content).toContain('XJ-9-Omega');

        // Check if score reflects hybrid nature (optional, depending on implementation detail exposure)
        // Ideally we check if it has a 'score' property.
        expect(results[0].score).toBeGreaterThan(0);
    });
});
