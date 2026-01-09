const { Router } = require('../src/router');

// Mock GoogleGenAI client
const mockSendMessage = jest.fn();
const mockCreate = jest.fn(() => ({
    sendMessage: mockSendMessage
}));

jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn(() => ({
        chats: {
            create: mockCreate
        }
    }))
}));

describe('Router', () => {
    let router;

    beforeEach(() => {
        router = new Router('fake-key');
        jest.clearAllMocks();
    });

    test('should route "Search my conversation" to PRO/STANDARD', async () => {
        // Mock LLM response
        mockSendMessage.mockResolvedValueOnce({
            text: JSON.stringify({
                model: 'PRO',
                toolMode: 'STANDARD',
                reason: 'Internal memory search requires tools',
                transcription: null
            })
        });

        const decision = await router.route('Busca mi conversacion con Can');

        expect(decision.model).toBe('PRO');
        expect(decision.toolMode).toBe('STANDARD');
    });
});
