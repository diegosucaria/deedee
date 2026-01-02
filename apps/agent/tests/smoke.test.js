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

// 3. Mock @google/genai
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    chats: {
      create: jest.fn().mockReturnValue({
        sendMessage: jest.fn().mockImplementation(async (payload) => {
          
          // Case A: User Message (Object with message property)
          // The Agent now sends { message: ... } for user input.
          if (payload?.message?.toLowerCase().includes('calendar')) {
            return {
              text: undefined, 
              candidates: [{
                content: {
                  parts: [{
                    functionCall: { name: 'listEvents', args: {} }
                  }]
                }
              }]
            };
          }

          // Case B: Function Response (Object)
          // The Agent now sends { role: 'function', parts: [...] }
          // We check specifically for this structure.
          if (payload && payload.role === 'function' && payload.parts?.[0]?.functionResponse) {
            return {
              text: 'You have one event.',
              candidates: [{
                content: {
                  parts: [{ text: 'You have one event.' }]
                }
              }]
            };
          }

          // Default
          return { text: 'I do not understand.', candidates: [] };
        })
      })
    }
  }))
}));

describe('Agent with Tools', () => {
  let agent;
  let mockInterface;

  beforeEach(() => {
    jest.clearAllMocks(); // Good practice to clear mocks between tests
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