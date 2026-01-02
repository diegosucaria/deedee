
const { Agent } = require('../src/agent');
const { GoogleGenAI } = require('@google/genai'); // Import the mocked class

// Mock dependencies
jest.mock('@google/genai'); // Mock the entire module
jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({ GSuiteTools: jest.fn() }));
jest.mock('@deedee/mcp-servers/src/local/index', () => ({ LocalTools: jest.fn() }));
jest.mock('../src/db');
jest.mock('../src/router');
jest.mock('../src/mcp-manager');
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
    agent.db = { getPendingGoals: jest.fn().mockReturnValue([]) };

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

  test('replyWithAudio calls Gemini API and sends audio', async () => {
    const result = await agent._executeTool('replyWithAudio', { text: 'Hello world' });

    expect(result.success).toBe(true);
    expect(mockInterface.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'audio'
    }));
    
    // Verify content is a base64 string and looks like a WAV (starts with 'UklGR' which is 'RIFF' in base64)
    const sentMsg = mockInterface.send.mock.calls[0][0];
    expect(sentMsg.content).toMatch(/^UklGR/);
  });
});
