
const { TitleService } = require('../src/services/title-service');

// Mock Dependencies
const mockAgent = {
    client: {
        models: {
            generateContent: jest.fn()
        }
    },
    db: {
        updateSessionTitle: jest.fn()
    },
    interface: {
        send: jest.fn()
    }
};

describe('TitleService', () => {
    let titleService;

    beforeEach(() => {
        jest.clearAllMocks();
        titleService = new TitleService(mockAgent);
        // Mock ConfigService lookup
        titleService.config = { getModel: jest.fn().mockReturnValue('gemini-2.0-flash') };
    });

    test('should extract title via .text()', async () => {
        mockAgent.client.models.generateContent.mockResolvedValue({
            text: () => 'New Title',
            candidates: []
        });

        await titleService.autoTitleSession('chat-1', 'Hello');

        expect(mockAgent.db.updateSessionTitle).toHaveBeenCalledWith('chat-1', 'New Title');
    });

    test('should extract title via parts fallback if .text() throws', async () => {
        mockAgent.client.models.generateContent.mockResolvedValue({
            text: () => { throw new Error('Failed'); },
            candidates: [{
                content: {
                    parts: [{ text: 'Fallback Title' }]
                }
            }]
        });

        await titleService.autoTitleSession('chat-2', 'Hello');

        expect(mockAgent.db.updateSessionTitle).toHaveBeenCalledWith('chat-2', 'Fallback Title');
    });

    test('should handle completely empty response gracefully', async () => {
        mockAgent.client.models.generateContent.mockResolvedValue({});

        await titleService.autoTitleSession('chat-3', 'Hello');

        expect(mockAgent.db.updateSessionTitle).not.toHaveBeenCalled();
    });
});
