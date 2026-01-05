
const { Agent } = require('../src/agent');
const { createUserMessage } = require('@deedee/shared/src/types');

describe('Agent Health Check', () => {
    let agent;

    beforeEach(() => {
        // Mock config
        agent = new Agent({ interface: { send: jest.fn(), on: jest.fn() }, googleApiKey: 'fake' });
        // Mock DB to avoid errors, though health check should skip it
        agent.db = {
            saveMessage: jest.fn(),
            logMetric: jest.fn(),
            logTokenUsage: jest.fn(),
            getHistoryForChat: jest.fn(),
            getPendingGoals: jest.fn().mockReturnValue([]) // Added for Goals feature
        };
        agent.rateLimiter = { check: jest.fn().mockResolvedValue(true) };
        agent.commandHandler = { handle: jest.fn().mockResolvedValue(false) };
    });

    test('should respond PONG to internal health check and skip DB', async () => {
        const msg = createUserMessage('HEALTH_CHECK_PING_123');
        msg.metadata = { internal_health_check: true };

        const sendCallback = jest.fn();
        const result = await agent.processMessage(msg, sendCallback);

        expect(sendCallback).toHaveBeenCalled();
        const reply = sendCallback.mock.calls[0][0];
        expect(reply.content).toBe('PONG');

        // Ensure DB was NOT called
        expect(agent.db.saveMessage).not.toHaveBeenCalled();
    });

    test('should process normal message normally', async () => {
        // Just verify it doesn't trigger the PONG logic
        const msg = createUserMessage('Hello');
        // We expect it to fail later at router/client because we didn't mock everything, 
        // but it should NOT return PONG.

        // Mock router causing throw to exit early or mock full chain? 
        // Let's just expect it NOT to return immediate PONG logic.
        agent.router = { route: jest.fn().mockResolvedValue({ model: 'FLASH' }) };
        agent.client = { chats: { create: () => ({ sendMessage: jest.fn().mockResolvedValue({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] }) }) } };
        agent.mcp = { getTools: jest.fn().mockResolvedValue([]) };

        const sendCallback = jest.fn();
        await agent.processMessage(msg, sendCallback);

        // Should have called saveMessage
        expect(agent.db.saveMessage).toHaveBeenCalled();
    });
});
