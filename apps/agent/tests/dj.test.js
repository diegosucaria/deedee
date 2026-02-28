const { DJService } = require('../src/services/dj-service');
const fs = require('fs');
const path = require('path');

// Mock dependencies
const mockAgent = {
    db: {
        addVinyl: jest.fn().mockReturnValue('vinyl_123'),
        getVinyls: jest.fn().mockReturnValue([]),
        logTokenUsage: jest.fn()
    },
    vaults: {
        vaultsDir: '/tmp/test_vaults',
        createVault: jest.fn(),
        updateVaultPage: jest.fn()
    },
    interface: { broadcast: jest.fn() },
    client: {
        models: {
            generateContent: jest.fn().mockResolvedValue({
                text: JSON.stringify({
                    type: 'cover',
                    artist: "Test Artist",
                    title: "Test Title",
                    label: "Test Label",
                    confidence: 0.9
                }),
                candidates: [{
                    content: {
                        parts: [{
                            text: JSON.stringify({
                                type: 'cover',
                                artist: "Test Artist",
                                title: "Test Title",
                                label: "Test Label",
                                confidence: 0.9
                            })
                        }]
                    }
                }]
            })
        },
        // Legacy compat for recommendVinyl (still uses getGenerativeModel)
        getGenerativeModel: jest.fn().mockReturnValue({
            generateContent: jest.fn().mockResolvedValue({
                response: {
                    text: () => "Recommendation: Track A - B",
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 }
                }
            })
        })
    }
};

describe('DJService', () => {
    let djService;

    beforeEach(() => {
        jest.clearAllMocks();
        djService = new DJService(mockAgent);
        // Mock _prepareImagePart to avoid FS calls
        djService._prepareImagePart = jest.fn().mockResolvedValue({ inlineData: { data: 'base64', mimeType: 'image/jpeg' } });
        // Mock _enrichMetadata to avoid real Gemini calls
        djService._enrichMetadata = jest.fn().mockResolvedValue({
            bpm: 128, key: 'Am', genre: 'House', year: 2024
        });
        // Mock FS operations to prevent real file writes
        jest.spyOn(fs, 'copyFileSync').mockImplementation(() => { });
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { });
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
    });

    test('should initialize and create vault if missing', async () => {
        const fs = require('fs');
        jest.spyOn(fs, 'existsSync').mockReturnValue(false);

        await djService.initialize();

        expect(mockAgent.vaults.createVault).toHaveBeenCalledWith('dj_history');
        expect(mockAgent.vaults.updateVaultPage).toHaveBeenCalled();
    });

    test('ingestVinyl should process image and return items', async () => {
        const result = await djService.ingestVinyl('/path/to/image.jpg');

        expect(djService._prepareImagePart).toHaveBeenCalledWith('/path/to/image.jpg');
        expect(mockAgent.client.models.generateContent).toHaveBeenCalled();
        expect(result).toHaveLength(1);
        expect(result[0].artist).toBe("Test Artist");
    });

    test('ingestVinylFromBase64 should process base64 image', async () => {
        const result = await djService.ingestVinylFromBase64('abc123base64', 'image/jpeg');

        expect(mockAgent.client.models.generateContent).toHaveBeenCalled();
        expect(result).toHaveLength(1);
        expect(result[0].artist).toBe("Test Artist");
    });

    test('should enrich metadata with BPM, key, genre', async () => {
        const result = await djService.ingestVinyl('/path/to/image.jpg');

        expect(djService._enrichMetadata).toHaveBeenCalledWith("Test Artist", "Test Title", "Test Label");
        expect(result[0].bpm).toBe(128);
        expect(result[0].key).toBe('Am');
    });

    test('recommendVinyl should handle empty crate', async () => {
        mockAgent.db.getVinyls.mockReturnValue([]);
        const result = await djService.recommendVinyl('Some Track', 'chat_1');
        expect(result).toContain("empty");
    });

    test('recommendVinyl should call model if crate has items', async () => {
        mockAgent.db.getVinyls.mockReturnValue([{ artist: 'A', title: 'B' }]);

        const mockModel = mockAgent.client.getGenerativeModel();
        mockModel.generateContent.mockResolvedValueOnce({
            response: {
                text: () => "Recommendation: Track A - B",
                usageMetadata: { totalTokenCount: 50 }
            }
        });

        const result = await djService.recommendVinyl('Some Track', 'chat_1');

        expect(result).toBe("Recommendation: Track A - B");
        expect(mockAgent.db.logTokenUsage).toHaveBeenCalledWith(expect.objectContaining({ tag: 'dj_mode' }));
    });
});
