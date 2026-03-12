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

        mockAgent = {
            client: {
                models: {
                    embedContent: jest.fn().mockImplementation((opts) => {
                        // Mock return structure
                        return Promise.resolve({
                            embeddings: [{ values: [0.1, 0.2, 0.3] }]
                        });
                    })
                }
            }
        };

        // Initialize Service
        // Mock ConfigService to return test-embedding-004
        ragService = new RagService(mockAgent);
        ragService.config = { getModel: jest.fn().mockReturnValue('text-embedding-004'), logUsageFromResponse: jest.fn().mockReturnValue({ cost: 0, tokens: 0 }) };
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

        expect(mockAgent.client.models.embedContent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'text-embedding-004',
            config: expect.objectContaining({ taskType: 'RETRIEVAL_DOCUMENT' })
        }));
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

    test('should delete document and chunks', async () => {
        const docId = 123;
        const filename = 'delete_me.txt';
        const vaultId = 'trash';

        // Mock finding the doc
        mockGet.mockReturnValue({ id: docId });

        const result = await ragService.deleteDocument(filename, vaultId);

        expect(mockGet).toHaveBeenCalledWith(filename, vaultId);
        expect(mockRun).toHaveBeenCalledWith(docId); // Deleting chunks and doc
        expect(result).toBe(true);
    });

    test('should list documents for a vault', () => {
        const vaultId = 'finance';
        mockAll.mockReturnValue([{ id: 1, filename: 'doc.txt', chunk_count: 5 }]);

        const docs = ragService.listDocuments(vaultId);

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('SELECT'));
        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('WHERE d.vault_id = ?'));
        expect(mockAll).toHaveBeenCalledWith(vaultId);
        expect(docs[0].filename).toBe('doc.txt');
    });

    test('should ingest an image file with multimodal embedding', async () => {
        const filePath = '/tmp/photo.png';
        const vaultId = 'photos';
        const imageBuffer = Buffer.alloc(1024); // Small fake image
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(imageBuffer);
        path.basename = jest.fn().mockReturnValue('photo.png');
        path.extname = jest.fn().mockReturnValue('.png');

        // Mock no existing doc
        mockGet.mockReturnValue(null);

        await ragService.ingestDocument(filePath, vaultId);

        // Should use inlineData (not text) for multimodal embedding
        expect(mockAgent.client.models.embedContent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'text-embedding-004',
            contents: [{
                parts: [{ inlineData: { mimeType: 'image/png', data: expect.any(String) } }]
            }]
        }));

        // Should insert chunk with content_type = 'image'
        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO chunks'));
        expect(mockRun).toHaveBeenCalledWith(
            expect.any(Number), '[IMAGE] photo.png', expect.any(Buffer), 0, 'image'
        );
    });

    test('should ingest audio file with multimodal embedding', async () => {
        const filePath = '/tmp/clip.mp3';
        const vaultId = 'audio';
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(Buffer.alloc(2048));
        path.basename = jest.fn().mockReturnValue('clip.mp3');
        path.extname = jest.fn().mockReturnValue('.mp3');
        mockGet.mockReturnValue(null);

        await ragService.ingestDocument(filePath, vaultId);

        expect(mockAgent.client.models.embedContent).toHaveBeenCalledWith(expect.objectContaining({
            contents: [{
                parts: [{ inlineData: { mimeType: 'audio/mpeg', data: expect.any(String) } }]
            }]
        }));
    });

    test('should skip multimodal embedding for files over 20MB', async () => {
        const filePath = '/tmp/huge.png';
        const vaultId = 'photos';
        const hugeBuffer = Buffer.alloc(21 * 1024 * 1024); // 21MB
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(hugeBuffer);
        path.basename = jest.fn().mockReturnValue('huge.png');
        path.extname = jest.fn().mockReturnValue('.png');
        mockGet.mockReturnValue(null);

        const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
        await ragService.ingestDocument(filePath, vaultId);
        consoleSpy.mockRestore();

        // Should NOT call embedContent for oversized files
        expect(mockAgent.client.models.embedContent).not.toHaveBeenCalled();
    });

    test('_getMediaType should detect supported media types', () => {
        expect(ragService._getMediaType('.png')).toEqual({ type: 'image', mimeType: 'image/png' });
        expect(ragService._getMediaType('.jpg')).toEqual({ type: 'image', mimeType: 'image/jpeg' });
        expect(ragService._getMediaType('.mp3')).toEqual({ type: 'audio', mimeType: 'audio/mpeg' });
        expect(ragService._getMediaType('.mp4')).toEqual({ type: 'video', mimeType: 'video/mp4' });
        expect(ragService._getMediaType('.txt')).toBeNull();
        expect(ragService._getMediaType('.md')).toBeNull();
    });
});
