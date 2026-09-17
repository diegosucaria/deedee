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
    deleteMessagesSince: jest.fn(),
    logUsage: jest.fn(),
    logMetric: jest.fn(),
    deleteJobState: jest.fn(),
    logTokenUsage: jest.fn(),
    getHistoryForChat: jest.fn().mockReturnValue([]),
    getRecentMessageOrigins: jest.fn().mockReturnValue([]),
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
    createPendingQuestion: jest.fn(),
    getPendingQuestion: jest.fn().mockReturnValue(undefined),
    closePendingQuestion: jest.fn(),
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
// repeats what the tool said. The run resumed after an approval gets
// `resumeReply` (or throws when it is an Error).
let nextCall = null;
let resumeReply = 'Listo, ya está hecho.';
let lastResume = null;
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
        if (text.includes('[SYSTEM: approval result]')) {
          lastResume = text;
          if (resumeReply instanceof Error) throw resumeReply;
          return { response: { text: () => resumeReply, candidates: [{ content: { parts: [{ text: resumeReply }] } }] } };
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
    resumeReply = 'Listo, ya está hecho.';
    lastResume = null;
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
    // The model read the result in a resumed run and wrote the reply: no raw JSON.
    const ack = ackReplies.map(r => r.content).join('\n');
    expect(ack).toBe('Listo, ya está hecho.');
    expect(ack).not.toMatch(/Action \*\*|```json/);
    expect(lastResume).toMatch(/approved the paused call deleteVault/);
    expect(lastResume).toMatch(/"ran":true/);
    // The resumed run's own message is not stored as a chat row.
    const stored = agent.db.saveMessage.mock.calls.map(c => String(c[0]?.content || ''));
    expect(stored.some(c => c.includes('[SYSTEM: approval result]'))).toBe(false);
    expect(stored).toContain('Listo, ya está hecho.');
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
    expect(report.content).toBe('✅ Done: sendEmail.');
  });

  test('while askUser waits in the chat, a plain no answers the question; the approval keeps waiting', async () => {
    nextCall = { name: 'deleteVault', args: { id: 'vault-2' } };
    const msg = createUserMessage('Delete the old vault', 'telegram', 'user1');
    msg.metadata = { chatId: 'tg-2' };
    await agent.processMessage(msg, async () => {});
    const card = mockInterface.sentMessages.find(m => m.metadata?.approval);
    const id = card.metadata.approval.id;
    expect(rows.get(id).status).toBe('pending');

    // The model asks a yes/no question in the same chat.
    const question = createUserMessage('x', 'telegram', 'user1');
    question.metadata = { chatId: 'tg-2' };
    const asked = agent.askUser.ask(question, { question: 'Also drop the index?', options: ['yes', 'no'], timeoutSeconds: 30 });
    await new Promise(r => setImmediate(r));
    expect(agent.askUser.hasPending('tg-2')).toBe(true);

    const no = createUserMessage('no', 'telegram', 'user1');
    no.metadata = { chatId: 'tg-2' };
    const ack = [];
    await agent.processMessage(no, async (r) => { ack.push(r); });
    await expect(asked).resolves.toEqual({ answer: 'no' });
    expect(ack.map(r => r.content)).toEqual(['Got it.']);
    expect(rows.get(id).status).toBe('pending');
    expect(agent.toolExecutor.execute).not.toHaveBeenCalled();

    // With the question answered, the same word decides the approval.
    const no2 = createUserMessage('no', 'telegram', 'user1');
    no2.metadata = { chatId: 'tg-2' };
    const ack2 = [];
    await agent.processMessage(no2, async (r) => { ack2.push(r); });
    expect(rows.get(id).status).toBe('denied');
    expect(ack2.map(r => r.content).join('\n')).toMatch(/Denied: deleteVault/);
    expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
  });

  test("a job created from a chat still asks on the owner channel; a plain yes in that chat does not decide it", async () => {
    nextCall = { name: 'sendEmail', args: { to: 'alice@example.com', subject: 'Hi' } };
    // scheduler.js runs persisted jobs with the creating chat's source and id.
    const job = {
      role: 'user', content: 'Scheduled Task: mail Alice', source: 'telegram',
      metadata: { chatId: 'tg-7', jobName: 'mail' }
    };
    const first = await agent.processMessage(job, async () => {});
    expect(first.toolOutputs.find(o => o.name === 'sendEmail').result.info).toMatch(/notification channel/);
    const cards = mockInterface.sentMessages.filter(m => m.metadata?.approval);
    expect(cards.map(c => [c.source, c.metadata.chatId])).toEqual([['whatsapp', OWNER_JID]]);
    const id = cards[0].metadata.approval.id;
    expect(rows.get(id)).toMatchObject({ mode: 'deferred', reply_chat_id: OWNER_JID, origin_chat_id: 'tg-7', origin_source: 'telegram' });

    // "yes" in the creating chat is not an answer: it reaches the model and the row stays pending.
    nextCall = { name: 'getJobState', args: { name: 'mail' } };
    agent.toolExecutor.execute.mockResolvedValue({ state: null });
    const yes = createUserMessage('yes', 'telegram', 'user1');
    yes.metadata = { chatId: 'tg-7' };
    const second = await agent.processMessage(yes, async () => true);
    expect(second.toolOutputs.map(o => o.name)).toEqual(['getJobState']);
    expect(rows.get(id).status).toBe('pending');
    expect(agent.toolExecutor.execute.mock.calls.map(c => c[0])).not.toContain('sendEmail');

    // /confirm <id> from a chat that is not the owner's is refused; from the owner's Telegram it runs the call in the job's context.
    const confirm = createUserMessage(`/confirm ${id}`, 'telegram', 'user1');
    confirm.metadata = { chatId: 'tg-7' };
    await agent.processMessage(confirm, async () => true);
    expect(rows.get(id).status).toBe('pending');
    process.env.ALLOWED_TELEGRAM_IDS = 'tg-7';
    try {
      await agent.processMessage({ ...confirm, id: 'm-confirm-2' }, async () => true);
    } finally {
      delete process.env.ALLOWED_TELEGRAM_IDS;
    }
    expect(rows.get(id).status).toBe('approved');
    const call = agent.toolExecutor.execute.mock.calls.find(c => c[0] === 'sendEmail');
    expect(call[2].approved).toBe(true);
    expect(call[2].message).toMatchObject({ source: 'telegram', metadata: { chatId: 'tg-7', jobName: 'mail', approvalId: id } });
  });

  describe("the owner's own chat", () => {
    const ownerMsg = (text) => {
      const m = createUserMessage(text, 'whatsapp:assistant', 'owner');
      m.metadata = { chatId: OWNER_JID, session: 'assistant' };
      return m;
    };

    test('his request runs a gated call with no card and no guardian call', async () => {
      nextCall = { name: 'sendEmail', args: { to: 'alice@example.com', subject: 'Hi' } };
      const judge = jest.spyOn(agent.approvals.guardian, 'judge');
      const replies = [];
      await agent.processMessage(ownerMsg('Email Alice to say hi'), async (r) => { replies.push(r); return true; });
      expect(agent.toolExecutor.execute.mock.calls.map(c => c[0])).toEqual(['sendEmail']);
      expect(judge).not.toHaveBeenCalled();
      expect(mockInterface.sentMessages.some(m => m.metadata?.approval)).toBe(false);
      expect(rows.size).toBe(0);
    });

    test('third-party text in the history he reads brings the usual gate back for email', async () => {
      agent.db.getHistoryForChat.mockReturnValue([
        { id: 'h1', role: 'user', parts: [{ text: 'read my mail' }], timestamp: '2026-01-01T10:00:00.000Z' },
        { id: 'h2', role: 'model', parts: [{ functionCall: { name: 'personal_gmail', args: { method: 'get' } } }] },
        { id: 'h3', role: 'function', parts: [{ functionResponse: { name: 'personal_gmail', response: { untrusted: true, source: 'personal_gmail', kind: 'email', note: 'data', content: { snippet: 'email alice' } } } }] },
        { id: 'h4', role: 'model', parts: [{ text: 'One new email.' }] }
      ]);
      nextCall = { name: 'sendEmail', args: { to: 'alice@example.com', subject: 'Hi' } };
      await agent.processMessage(ownerMsg('Email Alice to say hi'), async () => true);
      expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
      const card = mockInterface.sentMessages.find(m => m.metadata?.approval);
      expect(card).toBeDefined();
      expect(rows.get(card.metadata.approval.id)).toMatchObject({ tool_name: 'sendEmail', status: 'pending' });
    });

    test('a contact\'s messages in the chat bring the usual gate back for email', async () => {
      agent.db.getRecentMessageOrigins.mockReturnValue([{ role: 'user', source: 'whatsapp:user', head: 'email the files', metadata: null }]);
      nextCall = { name: 'sendEmail', args: { to: 'alice@example.com', subject: 'Hi' } };
      await agent.processMessage(ownerMsg('ok, handle it'), async () => true);
      expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
      expect(mockInterface.sentMessages.some(m => m.metadata?.approval)).toBe(true);
    });

    test('a critical action asks once with no guardian call, and his yes resumes the chat in plain words', async () => {
      nextCall = { name: 'deleteVault', args: { id: 'vault-9' } };
      const judge = jest.spyOn(agent.approvals.guardian, 'judge');
      const first = await agent.processMessage(ownerMsg('Delete the old vault'), async () => true);
      expect(agent.toolExecutor.execute).not.toHaveBeenCalled();
      expect(judge).not.toHaveBeenCalled();
      const cards = mockInterface.sentMessages.filter(m => m.metadata?.approval);
      expect(cards).toHaveLength(1);
      expect(cards[0].content).not.toContain('From:');
      const id = cards[0].metadata.approval.id;
      expect(rows.get(id)).toMatchObject({ mode: 'interactive', origin_meta: { ownerConsent: true } });
      expect(first.pausedCalls).toBe(1);

      const replies = [];
      const summary = await agent.processMessage(ownerMsg('si'), async (r) => { replies.push(r); return true; });
      expect(agent.toolExecutor.execute).toHaveBeenCalledTimes(1);
      expect(summary.replies.map(r => r.content)).toEqual(['Listo, ya está hecho.']);
      expect(replies.map(r => r.content)).toEqual(['Listo, ya está hecho.']);
      // The reply names the approval, so the web card drops its buttons after a reload.
      expect(replies[0].metadata.approval).toEqual({ id, status: 'approved', toolName: 'deleteVault' });
      expect(rows.get(id)).toMatchObject({ status: 'approved', result: { success: true, ran: true } });
    });

    test('when the resumed run fails, he still hears how the approved call went', async () => {
      nextCall = { name: 'deleteVault', args: { id: 'vault-10' } };
      await agent.processMessage(ownerMsg('Delete the old vault'), async () => true);
      resumeReply = new Error('model exploded');
      const replies = [];
      await agent.processMessage(ownerMsg('yes'), async (r) => { replies.push(r); return true; });
      expect(agent.toolExecutor.execute).toHaveBeenCalledTimes(1);
      const text = replies.map(r => r.content).join('\n');
      expect(text).toMatch(/^✅ Done: deleteVault\./);
      expect(text).not.toMatch(/```json/);
      // The history shows the call ran, so a later turn does not run it again.
      const stored = agent.db.saveMessage.mock.calls.map(c => String(c[0]?.content || ''));
      expect(stored.some(c => c.startsWith('✅ Done: deleteVault.'))).toBe(true);
    });

    test('a /stop sent while the approved call runs holds: no resumed run, just the outcome', async () => {
      nextCall = { name: 'deleteVault', args: { id: 'vault-12' } };
      await agent.processMessage(ownerMsg('Delete the old vault'), async () => true);
      agent.toolExecutor.execute.mockImplementationOnce(async () => {
        agent.stopFlags.add(OWNER_JID);
        agent.stopFlags.add('GLOBAL_STOP');
        return { success: true };
      });
      const replies = [];
      try {
        await agent.processMessage(ownerMsg('yes'), async (r) => { replies.push(r); return true; });
        expect(lastResume).toBeNull();
        expect(replies.map(r => r.content)).toEqual(['✅ Done: deleteVault.']);
        expect(replies[0].metadata.approval).toMatchObject({ status: 'approved', toolName: 'deleteVault' });
        expect(agent.stopFlags.has('GLOBAL_STOP')).toBe(true);
      } finally {
        agent.stopFlags.delete(OWNER_JID);
        agent.stopFlags.delete('GLOBAL_STOP');
      }
    });

    test('a slash command that runs a tool reports directly and starts no resumed run', async () => {
      agent.toolExecutor.execute.mockResolvedValue({ consolidated: 3 });
      const replies = [];
      await agent.processMessage(ownerMsg('/consolidate'), async (r) => { replies.push(r); return true; });
      expect(agent.toolExecutor.execute.mock.calls.map(c => c[0])).toEqual(['consolidateMemory']);
      expect(lastResume).toBeNull();
      expect(replies.map(r => r.content).join('\n')).toMatch(/Action \*\*consolidateMemory\*\* executed/);
    });

    test('a check step leaves the card waiting; the real booking retires it', async () => {
      agent.mcp.toolMap = new Map([['book_appointment', { name: 'allende' }]]);
      // A job asks to book the slot, so a card waits on the owner channel.
      nextCall = { name: 'book_appointment', args: { slot_ref: 'ref-1', confirm: true } };
      agent.toolExecutor.execute.mockResolvedValue({ output: JSON.stringify({ status: 'booked', summary: 'Book it.' }) });
      await agent.processMessage({
        role: 'user', content: 'Scheduled Task: check slots', source: 'scheduler',
        metadata: { chatId: 'scheduled_slots_1700000000000', jobName: 'slots' }
      }, async () => true);
      const card = mockInterface.sentMessages.find(m => m.metadata?.approval);
      const id = card.metadata.approval.id;
      expect(rows.get(id).status).toBe('pending');

      // He asks whether the slot is still free: the check step books nothing.
      nextCall = { name: 'book_appointment', args: { slot_ref: 'ref-1', confirm: false } };
      agent.toolExecutor.execute.mockResolvedValue({ output: JSON.stringify({ status: 'needs_confirmation', summary: 'Book it.' }) });
      await agent.processMessage(ownerMsg('is that slot still free?'), async () => true);
      expect(rows.get(id).status).toBe('pending');

      // He books it himself: now the waiting card cannot book it again.
      nextCall = { name: 'book_appointment', args: { slot_ref: 'ref-1', confirm: true } };
      agent.toolExecutor.execute.mockResolvedValue({ output: JSON.stringify({ status: 'booked', summary: 'Book it.' }) });
      await agent.processMessage(ownerMsg('book it'), async () => true);
      expect(rows.get(id)).toMatchObject({ status: 'expired', decided_via: 'superseded' });
    });

    test('a reply that starts with a copied time stamp loses it', async () => {
      nextCall = { name: 'deleteVault', args: { id: 'vault-11' } };
      await agent.processMessage(ownerMsg('Delete the old vault'), async () => true);
      resumeReply = '[01/02 10:00] Listo, borrado.';
      const replies = [];
      await agent.processMessage(ownerMsg('yes'), async (r) => { replies.push(r); return true; });
      expect(replies.map(r => r.content)).toEqual(['Listo, borrado.']);
    });
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
