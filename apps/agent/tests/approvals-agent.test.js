/**
 * Approvals wired into the Agent: the tool loop pauses a guarded call and
 * sends the card, a plain "yes" in the same chat resumes it as
 * EXECUTE_PENDING with the approved flag, and a scheduled run's card
 * reaches the owner channel where his "yes" runs the stored call.
 */
const { Agent } = require('../src/agent');
const { MockInterface } = require('./mock-interface');
const { createUserMessage } = require('@deedee/shared/src/types');

const OWNER_JID = '10000000000@s.whatsapp.net';

// In-memory pending_confirmations, enough for the service.
const rows = new Map();
const confirmationHelpers = {
  createPendingConfirmation: (r) => {
    const row = {
      id: r.id, origin_chat_id: r.originChatId, origin_source: r.originSource, origin_meta: r.originMeta || null,
      reply_chat_id: r.replyChatId, reply_channel: r.replyChannel, mode: r.mode, tool_name: r.toolName, args: r.args,
      summary: r.summary, reason: r.reason, status: 'pending', created_at: new Date().toISOString(),
      expires_at: r.expiresAt, decided_at: null, decided_via: null, result: null
    };
    rows.set(row.id, row);
    return { ...row };
  },
  getPendingConfirmation: (id) => (rows.get(id) ? { ...rows.get(id) } : null),
  listPendingConfirmations: ({ replyChatId } = {}) => [...rows.values()]
    .filter(r => r.status === 'pending' && (!replyChatId || r.reply_chat_id === replyChatId)).map(r => ({ ...r })),
  decidePendingConfirmation: (id, status, { via } = {}) => {
    const r = rows.get(id);
    if (!r || r.status !== 'pending') return null;
    Object.assign(r, { status, decided_via: via || null, decided_at: new Date().toISOString() });
    return { ...r };
  },
  expirePendingConfirmations: () => [],
  setConfirmationResult: (id, result) => { const r = rows.get(id); if (r) r.result = result; },
  listRecentConfirmations: () => [...rows.values()],
  countConfirmationsByStatus: () => ({ pending: 0, approved: 0, denied: 0, expired: 0 })
};

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
    countMessages: jest.fn().mockReturnValue(10),
    ensureSession: jest.fn(),
    getWatchers: jest.fn().mockReturnValue([]),
    updateWatcher: jest.fn(),
    getAllAgentSettings: jest.fn().mockReturnValue({ owner_phone: '+10000000000', notification_channel: 'whatsapp' }),
    getAgentSetting: jest.fn((key) => (key === 'owner_phone' ? { key, value: '+10000000000' } : null)),
    getPerson: jest.fn().mockReturnValue(null),
    markStaleSubAgents: jest.fn().mockReturnValue(0),
    expirePendingQuestions: jest.fn().mockReturnValue([]),
    getPendingQuestion: jest.fn().mockReturnValue(undefined),
    close: jest.fn().mockResolvedValue(),
    ...confirmationHelpers
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

// The model: first turn calls `nextCall`; after the function response it
// repeats what the tool said.
let nextCall = null;
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
          const r = fr.functionResponse.response;
          const t = `Tool said: ${r.info || r.error || JSON.stringify(r)}`;
          return { response: { text: () => t, candidates: [{ content: { parts: [{ text: t }] } }] } };
        }
        return { response: { text: () => undefined, candidates: [{ content: { parts: [{ functionCall: nextCall }] } }] } };
      })
    })
  }
}));

describe('approvals through the Agent', () => {
  let agent;
  let mockInterface;

  beforeEach(async () => {
    jest.clearAllMocks();
    rows.clear();
    mockInterface = new MockInterface();
    mockInterface.broadcast = jest.fn().mockResolvedValue(true);
    agent = new Agent({ googleApiKey: 'fake-key', interface: mockInterface });
    const mockModule = { GoogleGenAI: MockGoogleGenAI };
    agent._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
    agent.router._loadClientLibrary = jest.fn().mockResolvedValue(mockModule);
    if (agent.mcp) agent.mcp.close = jest.fn().mockResolvedValue();
    agent.toolExecutor.execute = jest.fn().mockResolvedValue({ success: true, ran: true });
    await agent.start();
  });

  afterEach(async () => { if (agent) await agent.stop(); });

  test('a guarded call pauses, the card goes out, and a plain yes in the chat resumes it as approved', async () => {
    // deleteVault carries the requiresConfirmation flag and runs through the executor.
    nextCall = { name: 'deleteVault', args: { id: 'vault-1' } };
    const msg = createUserMessage('Delete the old vault', 'telegram', 'user1');
    msg.metadata = { chatId: 'tg-1' };
    const replies = [];
    const first = await agent.processMessage(msg, async (r) => { replies.push(r); });

    // The tool never ran; the model got the pause and told the user.
    expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
    const paused = first.toolOutputs.find(o => o.name === 'deleteVault');
    expect(paused.result.info).toMatch(/Action PAUSED/);
    expect(replies.map(r => r.content).join('\n')).toMatch(/Action PAUSED/);

    // The card went through interface.send to the same chat, with the approval metadata.
    const card = mockInterface.sentMessages.find(m => m.metadata?.approval);
    expect(card).toBeDefined();
    expect(card.source).toBe('telegram');
    expect(card.metadata.chatId).toBe('tg-1');
    expect(card.content).toContain('Approval needed');
    expect(card.content).toContain('deleteVault');
    const id = card.metadata.approval.id;
    expect(rows.get(id)).toMatchObject({ status: 'pending', mode: 'interactive', reply_chat_id: 'tg-1' });

    // "yes" runs the stored call with the approved flag and never reaches the model.
    const yes = createUserMessage('yes', 'telegram', 'user1');
    yes.metadata = { chatId: 'tg-1' };
    const ackReplies = [];
    const summary = await agent.processMessage(yes, async (r) => { ackReplies.push(r); });
    expect(agent.toolExecutor.execute).toHaveBeenCalledTimes(1);
    const [name, args, context] = agent.toolExecutor.execute.mock.calls[0];
    expect(name).toBe('deleteVault');
    expect(args).toEqual({ id: 'vault-1' });
    expect(context.approved).toBe(true);
    expect(context.message.metadata.chatId).toBe('tg-1');
    expect(summary.toolOutputs).toEqual([{ name: 'deleteVault', result: { success: true, ran: true } }]);
    expect(ackReplies.map(r => r.content).join('\n')).toMatch(/Action \*\*deleteVault\*\* executed/);
    expect(rows.get(id)).toMatchObject({ status: 'approved', decided_via: 'chat', result: { success: true, ran: true } });
  });

  test('a scheduled run asks the owner on his channel; his yes from WhatsApp runs the call and reports back', async () => {
    nextCall = { name: 'sendEmail', args: { to: 'alice@example.com', subject: 'Hi' } };
    const job = {
      role: 'user', content: 'Scheduled Task: mail Alice', source: 'scheduler',
      metadata: { chatId: 'scheduled_mail_1700000000000', jobName: 'mail' }
    };
    const jobReplies = [];
    const first = await agent.processMessage(job, async (r) => { jobReplies.push(r); });
    expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
    expect(first.toolOutputs.find(o => o.name === 'sendEmail').result.info).toMatch(/notification channel/);

    const card = mockInterface.sentMessages.find(m => m.metadata?.approval);
    expect(card.source).toBe('whatsapp');
    expect(card.metadata.chatId).toBe(OWNER_JID);
    expect(card.metadata.session).toBe('assistant');
    expect(card.content).toContain('scheduled job "mail"');
    const id = card.metadata.approval.id;
    expect(rows.get(id)).toMatchObject({ mode: 'deferred', reply_chat_id: OWNER_JID, origin_source: 'scheduler' });

    // The owner answers from his WhatsApp chat.
    mockInterface.sentMessages = [];
    const yes = createUserMessage('dale', 'whatsapp:assistant', 'owner');
    yes.metadata = { chatId: OWNER_JID, session: 'assistant' };
    const summary = await agent.processMessage(yes, async () => true);
    expect(summary.toolOutputs).toHaveLength(0); // ran inside the service, not as a chat command
    expect(agent.toolExecutor.execute).toHaveBeenCalledTimes(1);
    const [name, args, context] = agent.toolExecutor.execute.mock.calls[0];
    expect(name).toBe('sendEmail');
    expect(args).toEqual({ to: 'alice@example.com', subject: 'Hi' });
    expect(context.approved).toBe(true);
    expect(context.message).toMatchObject({ source: 'scheduler', metadata: { chatId: 'scheduled_mail_1700000000000', jobName: 'mail', approvalId: id } });
    expect(rows.get(id)).toMatchObject({ status: 'approved', result: { success: true, ran: true } });
    const report = mockInterface.sentMessages.find(m => m.metadata?.approval?.status === 'approved');
    expect(report.metadata.chatId).toBe(OWNER_JID);
    expect(report.content).toMatch(/Approved and done: sendEmail/);
  });

  test('a call on the deny-list fails at once, with no card and no owner prompt', async () => {
    process.env.APPROVALS_DENY = 'commitAndPush';
    try {
      nextCall = { name: 'commitAndPush', args: { message: 'feat: x' } };
      const msg = createUserMessage('Push it', 'telegram', 'user1');
      msg.metadata = { chatId: 'tg-3' };
      const first = await agent.processMessage(msg, async () => {});
      expect(first.toolOutputs.find(o => o.name === 'commitAndPush').result.error).toMatch(/deny-list/);
      expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
      expect(mockInterface.sentMessages.some(m => m.metadata?.approval)).toBe(false);
      expect(rows.size).toBe(0);
    } finally {
      delete process.env.APPROVALS_DENY;
    }
  });
});
