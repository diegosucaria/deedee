const { Router } = require('../src/router');

// Mock ConfigService
jest.mock('../src/services/config-service', () => ({
    ConfigService: jest.fn().mockImplementation(() => ({
        getModel: jest.fn().mockReturnValue('gemini-2.0-flash-exp')
    }))
}));

describe('Router', () => {
    let router;
    let mockCreate;
    let mockSendMessage;

    beforeEach(() => {
        router = new Router('fake-key');

        mockSendMessage = jest.fn();
        mockCreate = jest.fn(() => ({
            sendMessage: mockSendMessage
        }));

        // Spy on private method to inject mock client
        jest.spyOn(router, '_loadClientLibrary').mockResolvedValue({
            GoogleGenAI: jest.fn(() => ({
                chats: {
                    create: mockCreate
                }
            }))
        });
    });

    afterEach(() => {
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

    test('should fall back to PRO with every tool when routing fails', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => { });
        const log = jest.spyOn(console, 'log').mockImplementation(() => { });
        mockSendMessage.mockRejectedValue(new Error('network down'));

        const decision = await router.route('turn on the lights', [], null);

        expect(decision.model).toBe('PRO');
        expect(decision.toolMode).toBe('STANDARD');
        // No toolGroups: the agent skips scoping so home/workspace tools stay loaded.
        expect(decision).not.toHaveProperty('toolGroups');
        expect(log).toHaveBeenCalledWith('[Router] fallback: all tools');
    });

    test('should stick to PRO for confirmation "ok" if lastModel was PRO', async () => {
        // Mock LLM response
        mockSendMessage.mockResolvedValueOnce({
            text: JSON.stringify({
                model: 'PRO',
                toolMode: 'STANDARD',
                reason: 'Sticky routing enforced due to previous PRO context',
                transcription: null
            })
        });

        // Pass lastModel = 'PRO'
        const decision = await router.route('ok', [], 'PRO');

        const callArgs = mockSendMessage.mock.calls[0][0];
        // Using Regex to be safe against whitespace. Handles "**Last Used Model:** PRO"
        if (!/Last Used Model:\*\*\s*PRO/.test(callArgs.message)) {
            throw new Error(`Prompt missing sticky context (Regex failed). Preview: ${callArgs.message.slice(0, 100)}...`);
        }

        expect(decision.model).toBe('PRO');
    });
});
