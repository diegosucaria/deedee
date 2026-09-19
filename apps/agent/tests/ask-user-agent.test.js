/**
 * askUser wired into the Agent: the tool blocks a run until the reply chat
 * answers, and processMessage hands that answer to the wait before the
 * command handler or the model see it.
 */
const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');
const { createUserMessage } = require('@deedee/shared/src/types');

const mockPendingRows = new Map();
jest.mock('../src/db', () => ({
  AgentDB: jest.fn().mockImplementation(() => ({
    db: { prepare: jest.fn().mockReturnValue({ all: jest.fn().mockReturnValue([]), get: jest.fn().mockReturnValue(null), run: jest.fn() }) },
    saveMessage: jest.fn(),
    getKey: jest.fn(),
    setKey: jest.fn(),
    getPendingGoals: jest.fn().mockReturnValue([]),
    saveScheduledJob: jest.fn(),
    deleteScheduledJob: jest.fn(),
    checkLimit: jest.fn().mockReturnValue(0),
    deleteMessagesFrom: jest.fn(),
    logUsage: jest.fn(),
    logMetric: jest.fn(),
    deleteJobState: jest.fn(),
    logTokenUsage: jest.fn(),
    getHistoryForChat: jest.fn().mockReturnValue([]),
    getScheduledJobs: jest.fn().mockReturnValue([]),
    getAllFacts: jest.fn().mockReturnValue([]),
    getFactsFormatted: jest.fn().mockReturnValue(''),
    saveSummary: jest.fn(),
    getLatestSummary: jest.fn().mockReturnValue(null),
    searchMessages: jest.fn().mockReturnValue([]),
    countMessages: jest.fn().mockReturnValue(0),
    ensureSession: jest.fn(),
    getWatchers: jest.fn().mockReturnValue([]),
    updateWatcher: jest.fn(),
    getAllAgentSettings: jest.fn().mockReturnValue({}),
    getPerson: jest.fn().mockReturnValue(null),
    markStaleSubAgents: jest.fn().mockReturnValue(0),
    expirePendingQuestions: jest.fn().mockReturnValue([]),
    createPendingQuestion: jest.fn((row) => { mockPendingRows.set(row.replyChatId, { ...row, status: 'pending' }); }),
    getPendingQuestion: jest.fn((chatId) => {
      const r = mockPendingRows.get(chatId);
      return r && r.status === 'pending' ? r : undefined;
    }),
    closePendingQuestion: jest.fn((id, status) => {
      for (const r of mockPendingRows.values()) if (r.id === id) r.status = status;
    }),
    close: jest.fn().mockResolvedValue()
  }))
}));

jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({
  GSuiteTools: jest.fn().mockImplementation(() => ({}))
}));

jest.mock('../src/mcp-manager', () => ({
  MCPManager: jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    getTools: jest.fn().mockResolvedValue([]),
    callTool: jest.fn(),
    toolMap: new Map(),
    close: jest.fn()
  }))
}));

// Model: first turn calls askUser; after the function response it answers with the code it got.
const MockGoogleGenAI = jest.fn().mockImplementation(() => ({
  chats: {
    create: jest.fn().mockReturnValue({
      sendMessage: jest.fn().mockImplementation(async (payload) => {
        const msg = payload?.message ?? payload;
        const parts = Array.isArray(msg) ? msg : (msg?.parts || []);
        const text = parts.map(p => p.text || '').join('\n');
        if (text.includes('You are the Router')) {
          const t = JSON.stringify({ model: 'FLASH', reason: 'test' });
          return { response: { text: () => t, candidates: [{ content: { parts: [{ text: t }] } }] } };
        }
        const fr = parts.find(p => p.functionResponse);
        if (fr) {
          const t = `Typed the code ${fr.functionResponse.response.answer}.`;
          return { response: { text: () => t, candidates: [{ content: { parts: [{ text: t }] } }] } };
        }
        return { response: { text: () => undefined, candidates: [{ content: { parts: [{ functionCall: { name: 'askUser', args: { question: 'SMS code?', timeoutSeconds: 60 } } }] } }] } };
      })
    })
  }
}));

describe('askUser through the Agent', () => {
  // Commands run only for the owner: tg-2 is his chat in the /stop test.
  const savedTelegramIds = process.env.ALLOWED_TELEGRAM_IDS;
  beforeAll(() => { process.env.ALLOWED_TELEGRAM_IDS = 'tg-2'; });
  afterAll(() => { if (savedTelegramIds === undefined) delete process.env.ALLOWED_TELEGRAM_IDS; else process.env.ALLOWED_TELEGRAM_IDS = savedTelegramIds; });

  let agent;
  let mockInterface;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPendingRows.clear();
    mockInterface = new MockInterface();
    mockInterface.broadcast = jest.fn().mockResolvedValue(true);
    agent = new Agent({ googleApiKey: 'fake-key', interface: mockInterface });
    const mockModule = { GoogleGenAI: MockGoogleGenAI };
    agent._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
    agent.router._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
    if (agent.mcp) agent.mcp.close = jest.fn().mockResolvedValue();
    await agent.start();
  });

  afterEach(async () => { agent.askUser.cancelAll(); if (agent) await agent.stop(); });

  test('askUser is a core tool with no category', () => {
    const { toolDefinitions } = require('../src/tools-definition');
    const tool = toolDefinitions.flatMap(t => t.functionDeclarations).find(t => t.name === 'askUser');
    expect(tool).toBeDefined();
    expect(tool.category).toBeUndefined();
    expect(tool.parameters.required).toEqual(['question']);
  });

  test('the run blocks on askUser; the next plain message in the chat answers it', async () => {
    const msg = createUserMessage('Pay the bill', 'telegram', 'user1');
    msg.metadata = { chatId: 'tg-1' };
    const replies = [];
    const run = agent.processMessage(msg, async (r) => { replies.push(r); });

    // Wait until the question went out through interface.send.
    for (let i = 0; i < 50 && mockInterface.sentMessages.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    const question = mockInterface.getLastMessage();
    expect(question.content).toBe('SMS code?');
    expect(question.source).toBe('telegram');
    expect(question.metadata).toEqual({ chatId: 'tg-1', question: { id: expect.any(String), options: [] } });
    expect(agent.askUser.hasPending('tg-1')).toBe(true);
    expect(replies).toHaveLength(0);

    // The reply is a new processMessage call; it must not reach the model.
    const answer = createUserMessage('482913', 'telegram', 'user1');
    answer.metadata = { chatId: 'tg-1' };
    const ackReplies = [];
    const summary = await agent.processMessage(answer, async (r) => { ackReplies.push(r); });
    expect(ackReplies.map(r => r.content)).toEqual(['Got it.']);
    expect(summary.replies).toHaveLength(1);
    expect(summary.toolOutputs).toHaveLength(0);

    const first = await run;
    const out = first.toolOutputs.find(o => o.name === 'askUser');
    expect(out.result).toEqual({ answer: '482913' });
    expect(replies.map(r => r.content)).toContain('Typed the code 482913.');
    expect(agent.askUser.hasPending('tg-1')).toBe(false);
  });

  test('/stop ends the wait and still runs as a command', async () => {
    const msg = createUserMessage('Pay the bill', 'telegram', 'user1');
    msg.metadata = { chatId: 'tg-2' };
    const run = agent.processMessage(msg, async () => {});
    for (let i = 0; i < 50 && mockInterface.sentMessages.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    expect(agent.askUser.hasPending('tg-2')).toBe(true);

    const stop = createUserMessage('/stop', 'telegram', 'user1');
    stop.metadata = { chatId: 'tg-2' };
    await agent.processMessage(stop, async () => {});
    expect(mockInterface.sentMessages.some(m => String(m.content).includes('Stopping'))).toBe(true);

    const first = await run;
    expect(first.toolOutputs.find(o => o.name === 'askUser').result).toEqual({ cancelled: true });
  });
});
