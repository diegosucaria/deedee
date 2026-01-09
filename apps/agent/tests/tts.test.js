
const { Agent } = require('../src/agent');
const { GoogleGenAI } = require('@google/genai'); // Import the mocked class

// Mock dependencies
jest.mock('@google/genai'); // Mock the entire module
jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({ GSuiteTools: jest.fn() }));
jest.mock('@deedee/mcp-servers/src/local/index', () => ({ LocalTools: jest.fn() }));
jest.mock('../src/db');
jest.mock('../src/router');
jest.mock('../src/mcp-manager', () => ({
  MCPManager: jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    getTools: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue()
  }))
}));
jest.mock('../src/rate-limiter', () => ({ RateLimiter: jest.fn() }));
jest.mock('../src/confirmation-manager', () => ({ ConfirmationManager: jest.fn() }));


describe('Agent TTS', () => {
  let agent;
  let mockInterface;

  beforeEach(async () => {
    mockInterface = { send: jest.fn(), on: jest.fn() };
    const config = { interface: mockInterface, googleApiKey: 'test-key' };
    agent = new Agent(config);
    // Mock DB setup
    agent.db = {
      getPendingGoals: jest.fn().mockReturnValue([]),
      getScheduledJobs: jest.fn().mockReturnValue([]),
      saveScheduledJob: jest.fn(),
      deleteScheduledJob: jest.fn(),
      saveMessage: jest.fn(),
      db: {
        prepare: jest.fn().mockReturnValue({
          get: jest.fn().mockReturnValue({ value: JSON.stringify('Kore') }),
          all: jest.fn().mockReturnValue([])
        })
      },
      close: jest.fn(),
      deleteJobState: jest.fn() // Added
    };

    // Force _loadClientLibrary to return our mock
    agent._loadClientLibrary = jest.fn().mockResolvedValue({
      GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: {
          generateContent: jest.fn().mockResolvedValue({
            candidates: [{
              content: {
                parts: [{
                  inlineData: {
                    data: Buffer.from('rawAudioData').toString('base64')
                  }
                }]
              }
            }]
          })
        }
      }))
    });

    // Trigger internal init to mock client
    await agent.start();
  });

  afterEach(async () => {
    if (agent) await agent.stop();
  });



  test('replyWithAudio calls Gemini API and sends audio', async () => {
    // Manually inject client and sync DB for direct tool execution test
    agent.toolExecutor.services.client = agent.client;
    agent.toolExecutor.services.db = agent.db;
    agent.toolExecutor.services.agent = agent;

    const mockSendCallback = jest.fn();
    const mockMessage = { metadata: { chatId: 'test-chat' }, source: 'telegram' };

    const result = await agent._executeTool(
      'replyWithAudio',
      { text: 'Hello world' },
      mockMessage,
      mockSendCallback
    );

    expect(result.success).toBe(true);

    // It should have called the callback with the audio message
    expect(mockSendCallback).toHaveBeenCalledWith(expect.objectContaining({
      parts: expect.arrayContaining([
        expect.objectContaining({
          inlineData: expect.objectContaining({
            mimeType: 'audio/wav'
          })
        })
      ])
    }));

    // Verify content matches input (WAV Wrapped)
    const sentMsg = mockSendCallback.mock.calls[0][0];
    const base64Audio = sentMsg.parts[0].inlineData.data;
    // Should start with RIFF (WAV header)
    expect(base64Audio).toMatch(/^UklGR/);
  });
});
