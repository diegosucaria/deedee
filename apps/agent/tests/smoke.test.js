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
    getPendingGoals: jest.fn().mockReturnValue([]),
    checkLimit: jest.fn().mockReturnValue(0),
    logUsage: jest.fn(),
    getHistoryForChat: jest.fn().mockReturnValue([])
  }))
}));

// Set Env Vars for Test
process.env.HA_URL = 'http://localhost';
process.env.HA_TOKEN = 'fake-token';

jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({
  GSuiteTools: jest.fn().mockImplementation(() => ({
    listEvents: jest.fn().mockResolvedValue([{ summary: 'Mock Event' }]),
    sendEmail: jest.fn()
  }))
}));

// 3. Mock @google/genai
// 3. Create Mock Class manually
const MockGoogleGenAI = jest.fn().mockImplementation(() => ({
  chats: {
    create: jest.fn().mockReturnValue({
      sendMessage: jest.fn().mockImplementation(async (payload) => {
        // Case A: User Message ({ message: string })
        if (typeof payload?.message === 'string' && payload.message.toLowerCase().includes('calendar')) {
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

        // Case B: Function Response
        if (Array.isArray(payload?.message) && payload.message[0]?.functionResponse) {
          return {
            text: 'You have one event.',
            candidates: [{
              content: {
                parts: [{ text: 'You have one event.' }]
              }
            }]
          };
        }

        return { text: 'I do not understand.', candidates: [] };
      })
    })
  }
}));

// We don't use jest.mock('@google/genai') anymore because it fails with dynamic imports in CJS tests.
// Instead we inject the mock via _loadClientLibrary spy.

describe('Agent with Tools', () => {
  let agent;
  let mockInterface;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockInterface = new MockInterface();
    agent = new Agent({
      googleApiKey: 'fake-key',
      interface: mockInterface
    });

    // SPY INJECTION
    const mockModule = { GoogleGenAI: MockGoogleGenAI };
    agent._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
    // Router is created in constructor, so we access it via agent.router
    agent.router._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should execute tool and reply', async () => {
    await agent.start();
    const userMsg = createUserMessage('Check my calendar', 'telegram', 'user1');

    const promise = agent.onMessage(userMsg);

    // Advance timers to trigger potential timeouts if any, or just let them sit mocked.
    // Since thinkTimer is 2.5s, if we don't advance, it never runs, which is fine.
    // But we need to make sure the promise resolves.

    await promise;

    const reply = mockInterface.getLastMessage();
    expect(reply.content).toBe('You have one event.');
  });
});