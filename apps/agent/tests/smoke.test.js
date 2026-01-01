const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');
const { createUserMessage } = require('@deedee/shared/src/types');

// Mock Google Generative AI to avoid real API calls in tests
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockResolvedValue({
        response: {
          text: () => 'I am Deedee'
        }
      })
    })
  }))
}));

describe('Agent Smoke Test', () => {
  let agent;
  let mockInterface;

  beforeEach(() => {
    mockInterface = new MockInterface();
    agent = new Agent({
      googleApiKey: 'fake-key',
      interface: mockInterface
    });
  });

  test('should reply to a message', async () => {
    await agent.start();

    const userMsg = createUserMessage('Who are you?', 'telegram', 'user123');
    
    // Simulate incoming message
    await agent.onMessage(userMsg);

    const reply = mockInterface.getLastMessage();
    expect(reply).toBeDefined();
    expect(reply.role).toBe('assistant');
    expect(reply.content).toBe('I am Deedee');
  });
});
