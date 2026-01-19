const { DJService } = require('../src/services/dj-service');
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
    client: {
        getGenerativeModel: jest.fn().mockReturnValue({
            generateContent: jest.fn().mockResolvedValue({
                response: {
                    text: () => JSON.stringify({
                        type: 'cover',
                        artist: "Test Artist",
                        title: "Test Title",
                        label: "Test Label",
                        confidence: 0.9
                    }),
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
        // Mock internal methods to avoid FS calls for images
        djService._prepareImagePart = jest.fn().mockResolvedValue({ inlineData: { data: 'base64', mimeType: 'image/jpeg' } });
        djService._enrichAndSave = jest.fn().mockImplementation((item) => {
            return { ...item, id: 'vinyl_123' };
        });
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
        expect(mockAgent.client.getGenerativeModel).toHaveBeenCalled();
        expect(result).toHaveLength(1);
        expect(result[0].artist).toBe("Test Artist");
    });

    test('recommendVinyl should handle empty crate', async () => {
        mockAgent.db.getVinyls.mockReturnValue([]);
        const result = await djService.recommendVinyl('Some Track', 'chat_1');
        expect(result).toContain("empty");
    });

    test('recommendVinyl should call model if crate has items', async () => {
        mockAgent.db.getVinyls.mockReturnValue([{ artist: 'A', title: 'B' }]);

        // Mock specific response for recommendation
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
