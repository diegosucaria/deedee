const { RagService } = require('../src/services/rag-service');
const fs = require('fs');
const path = require('path');

// Mock Dependencies
jest.mock('fs');
jest.mock('pdf-parse', () => {
    return jest.fn().mockResolvedValue({ text: 'This is a PDF content.' });
});

// Mock Database (We can use a real in-memory SQLite for testing if better-sqlite3 works in jest environment, 
// usually it does if not using strict isolation. But let's verify logic with mocks if needed, 
// or use a temp file.)
// Actually better-sqlite3 in-memory is great for tests.
// But we need to ensure the Service uses it. Service path is hardcoded to 'data/rag.db'.
// I should allow injecting dbPath or DB instance.
// But for now, I'll mock `better-sqlite3` to return a mock DB object.
const mockPrepare = jest.fn();
const mockRun = jest.fn().mockReturnValue({ lastInsertRowid: 1 });
const mockGet = jest.fn();
const mockAll = jest.fn();
const mockExec = jest.fn();

mockPrepare.mockReturnValue({
    run: mockRun,
    get: mockGet,
    all: mockAll
});

jest.mock('better-sqlite3', () => {
    return jest.fn().mockImplementation(() => {
        return {
            exec: mockExec,
            prepare: mockPrepare
        };
    });
});

describe('RagService', () => {
    let mockModel;

    beforeEach(() => {
        jest.clearAllMocks();

        mockModel = {
            embedContent: jest.fn().mockResolvedValue({
                embedding: { values: [0.1, 0.2, 0.3] }
            })
        };

        mockAgent = {
            client: {
                getGenerativeModel: jest.fn().mockReturnValue(mockModel)
            }
        };

        // Initialize Service
        ragService = new RagService(mockAgent);
    });

    test('should initialize database', () => {
        expect(mockExec).toHaveBeenCalled();
    });

    test('should ingest a text file with vault context', async () => {
        const filePath = '/tmp/test.txt';
        const vaultId = 'finance';
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(Buffer.from('Hello world content.'));
        path.basename = jest.fn().mockReturnValue('test.txt');
        path.extname = jest.fn().mockReturnValue('.txt');

        // Mock no existing doc
        mockGet.mockReturnValue(null);

        await ragService.ingestDocument(filePath, vaultId);

        expect(mockAgent.client.getGenerativeModel).toHaveBeenCalled();
        expect(mockModel.embedContent).toHaveBeenCalled();
        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO documents'));
        // Verify vault_id is passed
        expect(mockRun).toHaveBeenCalledWith(filePath, 'test.txt', expect.any(String), vaultId, expect.any(String));
    });

    test('should search documents with vault scope', async () => {
        const query = 'test query';
        const vaultId = 'finance';
        const mockEmbedding = new Float32Array([0.1, 0.2, 0.3]);
        const buffer = Buffer.from(mockEmbedding.buffer);

        mockAll.mockReturnValue([
            { id: 1, content: 'chunk 1', embedding: buffer, filename: 'test.txt', vault_id: 'finance' }
        ]);

        const results = await ragService.search(query, vaultId);

        expect(results.length).toBe(1);
        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('WHERE documents.vault_id = ?'));
    });
});
