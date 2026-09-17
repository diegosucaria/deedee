/**
 * A browser_ tool result that carries `_images` reaches the model as
 * functionResponse.parts[].inlineData and nowhere else: not the summary,
 * not the DB row, not the UI preview.
 */
const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');
const { createUserMessage } = require('@deedee/shared/src/types');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
    close: jest.fn().mockResolvedValue()
  }))
}));

jest.mock('@deedee/mcp-servers/src/gsuite/index', () => ({
  GSuiteTools: jest.fn().mockImplementation(() => ({}))
}));

const mockCallTool = jest.fn();
jest.mock('../src/mcp-manager', () => ({
  MCPManager: jest.fn().mockImplementation(() => ({
    init: jest.fn(),
    getTools: jest.fn().mockResolvedValue([]),
    callTool: (...a) => mockCallTool(...a),
    toolMap: new Map(),
    close: jest.fn()
  }))
}));

// Records every payload the agent sends to the model.
const sent = [];
const MockGoogleGenAI = jest.fn().mockImplementation(() => ({
  chats: {
    create: jest.fn().mockReturnValue({
      sendMessage: jest.fn().mockImplementation(async (payload) => {
        const msg = payload?.message ?? payload;
        const parts = Array.isArray(msg) ? msg : (msg?.parts || []);
        const text = parts.map(p => p.text || '').join('\n');
        sent.push(msg);
        if (text.includes('You are the Router')) {
          const t = JSON.stringify({ model: 'FLASH', reason: 'test' });
          return { response: { text: () => t, candidates: [{ content: { parts: [{ text: t }] } }] } };
        }
        if (parts.some(p => p.functionResponse)) {
          return { response: { text: () => 'The page shows a login form.', candidates: [{ content: { parts: [{ text: 'The page shows a login form.' }] } }] } };
        }
        return { response: { text: () => undefined, candidates: [{ content: { parts: [{ functionCall: { name: 'browser_take_screenshot', args: {} } }] } }] } };
      })
    })
  }
}));

describe('browser screenshots as inlineData', () => {
  let agent;
  let mockInterface;

  beforeEach(() => {
    jest.clearAllMocks();
    sent.length = 0;
    mockInterface = new MockInterface();
    mockInterface.broadcast = jest.fn().mockResolvedValue(true);
    agent = new Agent({ googleApiKey: 'fake-key', interface: mockInterface });
    const mockModule = { GoogleGenAI: MockGoogleGenAI };
    agent._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
    agent.router._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
    if (agent.mcp) agent.mcp.close = jest.fn().mockResolvedValue();
  });

  afterEach(async () => { if (agent) await agent.stop(); });

  test('_images go to the model as parts and are stripped everywhere else', async () => {
    mockCallTool.mockResolvedValue({ output: 'Took the viewport screenshot', _images: [{ mimeType: 'image/png', data: PNG }] });
    await agent.start();

    const msg = createUserMessage('Take a screenshot of the page', 'telegram', 'user1');
    const summary = await agent.processMessage(msg, async () => {});

    // Summary: result present, images gone.
    const out = summary.toolOutputs.find(o => o.name === 'browser_take_screenshot');
    expect(out).toBeDefined();
    expect(out.result).toEqual({ output: 'Took the viewport screenshot' });
    expect(JSON.stringify(summary)).not.toContain(PNG);

    // Model payload: functionResponse with inlineData parts.
    const fr = sent.flatMap(m => (Array.isArray(m) ? m : m.parts || [])).find(p => p.functionResponse);
    expect(fr).toBeDefined();
    expect(fr.functionResponse.name).toBe('browser_take_screenshot');
    // A web page is untrusted: the result reaches the model in the data envelope.
    expect(fr.functionResponse.response).toMatchObject({ untrusted: true, source: 'browser_take_screenshot', kind: 'a web page', content: { output: 'Took the viewport screenshot' } });
    expect(fr.functionResponse.parts).toEqual([{ inlineData: { mimeType: 'image/png', data: PNG } }]);

    // DB row: no base64, just the count.
    const fnRows = agent.db.saveMessage.mock.calls.map(c => c[0]).filter(r => r.role === 'function');
    expect(fnRows).toHaveLength(1);
    expect(JSON.stringify(fnRows[0])).not.toContain(PNG);
    expect(fnRows[0].parts[0].functionResponse.response._images).toBe('1 image(s) sent to model');

    // UI preview: no base64.
    const previews = mockInterface.broadcast.mock.calls.filter(c => c[0] === 'agent:tool_result').map(c => JSON.stringify(c[1]));
    expect(previews.length).toBeGreaterThan(0);
    for (const p of previews) expect(p).not.toContain(PNG);
  });

  test('browser_ tools keep secret names as typed', async () => {
    mockCallTool.mockResolvedValue({ output: 'typed' });
    await agent.start();
    agent.skillService.getAllEnabledSecrets = () => ({ SITE_PASSWORD: 'real-value' });

    await agent._executeTool('browser_type', { ref: 'e1', text: '$SITE_PASSWORD' });
    expect(mockCallTool).toHaveBeenCalledWith('browser_type', { ref: 'e1', text: '$SITE_PASSWORD' });

    await agent._executeTool('plex_play', { token: '$SITE_PASSWORD' });
    expect(mockCallTool).toHaveBeenLastCalledWith('plex_play', { token: 'real-value' });
  });
});
