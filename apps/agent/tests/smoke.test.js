const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');
const { createUserMessage } = require('@deedee/shared/src/types');

// Mock DB
jest.mock('../src/db', () => ({
  AgentDB: jest.fn().mockImplementation(() => ({
    saveMessage: jest.fn(),
    getKey: jest.fn(),
    setKey: jest.fn(),
    addGoal: jest.fn().mockReturnValue({ lastInsertRowid: 1 }),
    completeGoal: jest.fn(),
    getPendingGoals: jest.fn().mockReturnValue([])
  }))
}));

jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({
  GSuiteTools: jest.fn().mockImplementation(() => ({
    listEvents: jest.fn().mockResolvedValue([{ summary: 'Mock Event' }]),
    sendEmail: jest.fn()
  }))
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      startChat: jest.fn().mockReturnValue({
        sendMessage: jest.fn().mockImplementation(async (content) => {
          // 1. First call simulates Model asking to call function
          if (typeof content === 'string' && content.includes('calendar')) {
            return {
              response: {
                text: () => '',
                functionCalls: () => [{ name: 'listEvents', args: {} }]
              }
            };
          }
          // 2. Second call simulates Model seeing the result
          return {
            response: {
              text: () => 'You have one event.',
              functionCalls: () => []
            }
          };
        })
      })
    })
  }))
}));

describe('Agent with Tools', () => {
  let agent;
  let mockInterface;

  beforeEach(() => {
    mockInterface = new MockInterface();
    agent = new Agent({
      googleApiKey: 'fake-key',
      interface: mockInterface
    });
  });

  test('should execute tool and reply', async () => {
    await agent.start();
    const userMsg = createUserMessage('Check my calendar', 'telegram', 'user1');
    
    await agent.onMessage(userMsg);

    const reply = mockInterface.getLastMessage();
    expect(reply.content).toBe('You have one event.');
  });
});