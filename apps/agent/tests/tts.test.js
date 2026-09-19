
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
      deleteJobState: jest.fn(),
      getAllAgentSettings: jest.fn().mockReturnValue({}),
      markStaleSubAgents: jest.fn().mockReturnValue(0)
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

  describe('the language code reaches the speech call', () => {
    // A refactor once dropped it: the value was logged and never sent, so
    // the accent was whatever the model guessed.
    const speak = async (args) => {
      agent.toolExecutor.services.client = agent.client;
      agent.toolExecutor.services.db = agent.db;
      agent.toolExecutor.services.agent = agent;
      const result = await agent._executeTool('replyWithAudio', { text: 'Hola', ...args }, { metadata: { chatId: 'test-chat' }, source: 'telegram' }, jest.fn());
      return { result, calls: agent.client.models.generateContent.mock.calls.map(c => c[0].config.speechConfig) };
    };

    test('a language tag is sent; the old parameter name still works', async () => {
      expect((await speak({ languageCode: 'es-419' })).calls[0].languageCode).toBe('es-419');
      agent.client.models.generateContent.mockClear();
      expect((await speak({ language: 'en-US' })).calls[0].languageCode).toBe('en-US');
    });

    test('nothing is sent when no code is given, or when it is not a language tag', async () => {
      expect((await speak({})).calls[0]).not.toHaveProperty('languageCode');
      agent.client.models.generateContent.mockClear();
      expect((await speak({ languageCode: 'Spanish, please' })).calls[0]).not.toHaveProperty('languageCode');
    });

    test('a model that refuses the code still gets him the audio', async () => {
      const ok = await agent.client.models.generateContent();
      agent.client.models.generateContent.mockClear();
      agent.client.models.generateContent
        .mockRejectedValueOnce(new Error('400 INVALID_ARGUMENT: unsupported language code'))
        .mockResolvedValue(ok);
      const { result, calls } = await speak({ languageCode: 'xx-YY' });
      expect(result.success).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0].languageCode).toBe('xx-YY');
      expect(calls[1]).not.toHaveProperty('languageCode');
    });

    test('a quota error is not read as a refused language, whatever words it holds', async () => {
      // The SDK's message is the whole error body; a quota body names
      // "generativelanguage.googleapis.com". Retrying doubled the failed call.
      agent.client.models.generateContent.mockClear();
      const quota = Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"quotaMetric":"generativelanguage.googleapis.com/generate_content_requests"}]}}'), { status: 429 });
      agent.client.models.generateContent.mockRejectedValue(quota);
      const { calls } = await speak({ languageCode: 'es-419' }).catch(() => ({ calls: agent.client.models.generateContent.mock.calls }));
      expect(calls).toHaveLength(1);
    });

    test('another failure is not retried', async () => {
      agent.client.models.generateContent.mockClear();
      agent.client.models.generateContent.mockRejectedValue(new Error('503 overloaded'));
      const { calls } = await speak({ languageCode: 'es-419' }).catch(() => ({ calls: agent.client.models.generateContent.mock.calls }));
      expect(calls).toHaveLength(1);
    });
  });
});
