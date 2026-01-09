
const { Agent } = require('../src/agent');
const { createUserMessage } = require('@deedee/shared/src/types');

// Mock AgentDB globally as suggested by the comment
jest.mock('../src/db', () => ({
    AgentDB: jest.fn().mockImplementation(() => ({
        getPendingGoals: jest.fn().mockReturnValue([]),
        getScheduledJobs: jest.fn().mockReturnValue([]),
        saveMessage: jest.fn(),
        getLatestSummary: jest.fn().mockReturnValue(null),
        getHistoryForChat: jest.fn().mockReturnValue([]),
        logMetric: jest.fn(),
        logTokenUsage: jest.fn(),
        getAllFacts: jest.fn().mockReturnValue([]),
        getKey: jest.fn(),
        close: jest.fn()
    }))
}));

describe('Audio Response Suppression', () => {
    let agent;

    beforeEach(() => {
        // The AgentDB mock is now handled by jest.mock above.
        // We can create a new instance of Agent, and its db property will be the mocked instance.
        agent = new Agent({ interface: { send: jest.fn(), on: jest.fn(), broadcast: jest.fn().mockResolvedValue(true), emit: jest.fn() }, googleApiKey: 'fake' });
        // Reset mocks for each test if needed, or ensure the mock implementation handles it.
        // For simplicity, we'll assume the jest.mock setup is sufficient for the db property.
        // If specific calls need to be tracked per test, individual mocks on agent.db methods would be needed here.
        agent.rateLimiter = { check: jest.fn().mockResolvedValue(true) };
        agent.commandHandler = { handle: jest.fn().mockResolvedValue(false) };

        // Mock ToolExecutor to simulate audio tool execution
        agent.toolExecutor.execute = jest.fn();
    });

    afterEach(async () => {
        if (agent) await agent.stop();
    });

    test('should suppress text response if replyWithAudio was sent', async () => {
        const msg = createUserMessage('Speak to me');
        const sendCallback = jest.fn();

        // 1. Mock Router to return FLASH
        agent.router = { route: jest.fn().mockResolvedValue({ model: 'FLASH' }) };

        // 2. Mock Client to return function call THEN text
        agent.client = {
            chats: {
                create: () => ({
                    sendMessageStream: jest.fn()
                        .mockResolvedValueOnce({ // First call: Function Call
                            stream: (async function* () {
                                // No stream chunks needed for function call usually, or empty
                            })(),
                            response: Promise.resolve({
                                candidates: [{
                                    content: { parts: [{ functionCall: { name: 'replyWithAudio', args: { text: 'Hello' } } }] }
                                }]
                            })
                        })
                        .mockResolvedValueOnce({ // Second call: Final Text Response
                            stream: (async function* () {
                                yield { text: () => "I just spoke to you." };
                            })(),
                            response: Promise.resolve({
                                text: () => "I just spoke to you.",
                                candidates: [{ content: { parts: [{ text: "I just spoke to you." }] } }]
                            })
                        }),
                    sendMessage: jest.fn()
                        .mockResolvedValueOnce({
                            response: {
                                candidates: [{
                                    content: { parts: [{ functionCall: { name: 'replyWithAudio', args: { text: 'Hello' } } }] }
                                }]
                            }
                        })
                        .mockResolvedValueOnce({
                            response: {
                                text: () => "I just spoke to you.",
                                candidates: [{ content: { parts: [{ text: "I just spoke to you." }] } }]
                            }
                        })
                })
            }
        };

        // 3. Mock Tool Execution Success
        // We simulate that the tool internally called sendCallback with the audio
        agent._executeTool = jest.fn().mockImplementation(async (name, args, msg, sc) => {
            if (name === 'replyWithAudio') {
                // Simulate sending audio
                await sc({ parts: [{ inlineData: { mimeType: 'audio/wav', data: 'fake' } }] });
                return { success: true, info: 'Audio sent to user.' };
            }
        });

        const result = await agent.processMessage(msg, sendCallback);

        // Check calls
        // 1. Audio message sent?
        // _executeTool mock calls SC
        expect(sendCallback).toHaveBeenCalledWith(expect.objectContaining({ parts: expect.any(Array) }));

        // 2. Final text "I just spoke to you" sent?
        // It should NOT be sent because we suppressed it.
        const calls = sendCallback.mock.calls;
        const textCalls = calls.filter(args => args[0].content === "I just spoke to you.");
        expect(textCalls.length).toBe(0);

        // 3. But it SHOULD be saved to DB
        expect(agent.db.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "I just spoke to you." }));
    });
});
