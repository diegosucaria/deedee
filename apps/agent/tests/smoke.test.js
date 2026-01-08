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
    saveScheduledJob: jest.fn(),
    deleteScheduledJob: jest.fn(),
    checkLimit: jest.fn().mockReturnValue(0),
    logUsage: jest.fn(),
    logMetric: jest.fn(),
    logTokenUsage: jest.fn(),
    getHistoryForChat: jest.fn().mockReturnValue([]),
    getScheduledJobs: jest.fn().mockReturnValue([]),
    getAllFacts: jest.fn().mockReturnValue([]),
    saveSummary: jest.fn(),
    getLatestSummary: jest.fn().mockReturnValue(null),
    searchMessages: jest.fn().mockReturnValue([]) // Added for searchHistory tool
  }))
}));

// Set Env Vars for Test
process.env.HA_URL = 'http://localhost';
process.env.HA_TOKEN = 'fake-token';

GSuiteTools: jest.fn().mockImplementation(() => ({
  listEvents: jest.fn().mockResolvedValue([{ summary: 'Mock Event' }]),
  sendEmail: jest.fn()
}))

jest.mock('../src/mcp-manager', () => ({
  MCPManager: jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    getTools: jest.fn().mockResolvedValue([]),
    callTool: jest.fn(),
    close: jest.fn()
  }))
}));

// 3. Mock @google/genai
// 3. Create Mock Class manually
const MockGoogleGenAI = jest.fn().mockImplementation(() => ({
  chats: {
    create: jest.fn().mockReturnValue({
      sendMessageStream: jest.fn().mockImplementation(async (payload) => {
        let result = {};

        // Helper to extract text from payload
        const getPayloadText = (p) => {
          if (typeof p === 'string') return p;
          if (p?.parts && p.parts[0]?.text) return p.parts[0].text;
          if (p?.message) {
            if (typeof p.message === 'string') return p.message;
            if (p.message.parts && p.message.parts[0]?.text) return p.message.parts[0].text;
            return '';
          }
          return '';
        };

        const payloadText = getPayloadText(payload);
        const hasFunctionResponse = payload?.parts?.some(part => part.functionResponse) ||
          (Array.isArray(payload?.message) && payload.message[0]?.functionResponse) ||
          (payload?.message?.parts?.some && payload.message.parts.some(part => part.functionResponse));

        // Case A: Router Request
        if (payloadText.includes('You are the Router')) {
          result = {
            text: () => JSON.stringify({ model: 'FLASH', reason: 'Test Mock' }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ model: 'FLASH', reason: 'Test Mock' }) }] } }]
          };
        }

        // Case B: User Message ({ message: string })
        else if (payloadText.toLowerCase().includes('calendar')) {
          result = {
            text: () => undefined,
            candidates: [{
              content: { parts: [{ functionCall: { name: 'listEvents', args: {} } }] }
            }]
          };
        }

        // Case C: Function Response
        else if (hasFunctionResponse) {
          result = {
            text: () => 'You have one event.',
            candidates: [{ content: { parts: [{ text: 'You have one event.' }] } }]
          };
        }

        // Default
        else {
          result = {
            text: () => 'I do not understand.',
            candidates: [{ content: { parts: [{ text: 'I do not understand.' }] } }]
          };
        }

        // Return stream structure
        return {
          stream: (async function* () {
            if (result.candidates[0].content.parts[0].text) {
              yield { text: () => result.candidates[0].content.parts[0].text };
            }
          })(),
          response: Promise.resolve(result)
        };
      }),
      sendMessage: jest.fn().mockImplementation(async (payload) => {
        let result = {};
        const getPayloadText = (p) => {
          if (typeof p === 'string') return p;
          if (p?.parts && p.parts[0]?.text) return p.parts[0].text;
          if (p?.message) {
            if (typeof p.message === 'string') return p.message;
            if (p.message.parts && p.message.parts[0]?.text) return p.message.parts[0].text;
            return '';
          }
          return '';
        };

        const payloadText = getPayloadText(payload);
        const hasFunctionResponse = payload?.parts?.some(part => part.functionResponse) ||
          (Array.isArray(payload?.message) && payload.message[0]?.functionResponse) ||
          (payload?.message?.parts?.some && payload.message.parts.some(part => part.functionResponse));

        if (payloadText.includes('You are the Router')) {
          result = {
            text: () => JSON.stringify({ model: 'FLASH', reason: 'Test Mock' }),
            candidates: [{ content: { parts: [{ text: JSON.stringify({ model: 'FLASH', reason: 'Test Mock' }) }] } }]
          };
        }
        else if (payloadText.toLowerCase().includes('calendar')) {
          result = {
            text: () => undefined,
            candidates: [{
              content: { parts: [{ functionCall: { name: 'listEvents', args: {} } }] }
            }]
          };
        }
        else if (hasFunctionResponse) {
          result = {
            text: () => 'You have one event.',
            candidates: [{ content: { parts: [{ text: 'You have one event.' }] } }]
          };
        }
        else {
          result = {
            text: () => 'I do not understand.',
            candidates: [{ content: { parts: [{ text: 'I do not understand.' }] } }]
          };
        }
        return { response: result };
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
    mockInterface.broadcast = jest.fn().mockResolvedValue(true);
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

  test('should handle interface send failure gracefully', async () => {
    // Force interface to fail
    mockInterface.send = jest.fn().mockRejectedValue(new Error('Network Error'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

    await agent.start();
    const userMsg = createUserMessage('Hi', 'telegram', 'user1');

    // Should NOT throw
    await expect(agent.onMessage(userMsg)).resolves.not.toThrow();

    // Should have logged error? (Depends on implementation, check logs if needed)
    // expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Network Error'));

    consoleSpy.mockRestore();
  });
});