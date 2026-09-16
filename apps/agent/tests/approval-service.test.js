/**
 * ApprovalService: routing per source, cards through the delivery ledger,
 * yes/no vocabulary, several pending ids, coexistence with askUser,
 * deferred approvals that run the stored call, the deny-list, the sweeper
 * and the restart path. Real SQLite, fake interface.send.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { DeliveryService } = require('../src/services/delivery-service');
const { AskUserService } = require('../src/services/ask-user');
const {
    ApprovalService, normalizeApprovalSettings, decisionWord, summarizeArgs
} = require('../src/services/approval-service');

const OWNER_DIGITS = '10000000000';
const OWNER_JID = `${OWNER_DIGITS}@s.whatsapp.net`;
const TG_OWNER = '4242';

function makeAgent(db) {
    const agent = {
        db,
        settings: { owner_phone: `+${OWNER_DIGITS}`, notification_channel: 'whatsapp' },
        interface: { send: jest.fn().mockResolvedValue(true), broadcast: jest.fn().mockResolvedValue(true) },
        notifications: { create: jest.fn() },
        stopFlags: new Set(),
        cancellationFlags: new Set(),
        _executeTool: jest.fn().mockResolvedValue({ success: true, sent: 1 }),
        _getOwnerWaIds: jest.fn().mockResolvedValue(new Set([OWNER_JID, '200000000000002@lid'])),
        _normalizeWaChatId: (id) => (id && !id.includes('@') ? `${id.replace(/\D/g, '')}@s.whatsapp.net` : id)
    };
    agent.delivery = new DeliveryService(agent);
    return agent;
}

const msg = (source, chatId, content = 'do it', extra = {}) => ({
    id: `m-${Math.random()}`, role: 'user', content, source, timestamp: new Date().toISOString(),
    metadata: { chatId, ...extra }
});
const schedulerMsg = (jobName = 'morning') => msg('scheduler', `scheduled_${jobName}_1700000000000`, 'Scheduled Task: x', { jobName });
const watcherMsg = () => msg('whatsapp:user', '15550001234@s.whatsapp.net', 'SYSTEM_WATCHER_ALERT: a message from a contact matched', { phoneNumber: '15550001234' });

const sentTexts = (agent) => agent.interface.send.mock.calls.map(c => c[0]);

describe('ApprovalService', () => {
    let dir, db, agent, svc, warn, log, error;

    beforeEach(() => {
        process.env.ALLOWED_TELEGRAM_IDS = TG_OWNER;
        delete process.env.APPROVALS_DENY;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-approvals-'));
        db = new AgentDB(dir);
        agent = makeAgent(db);
        svc = new ApprovalService(agent);
        agent.approvals = svc;
        warn = jest.spyOn(console, 'warn').mockImplementation(() => { });
        log = jest.spyOn(console, 'log').mockImplementation(() => { });
        error = jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        svc.stop();
        warn.mockRestore(); log.mockRestore(); error.mockRestore();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env.ALLOWED_TELEGRAM_IDS;
        delete process.env.APPROVALS_DENY;
    });

    describe('route', () => {
        test('web and telegram chats answer in place', async () => {
            expect(await svc.route(msg('web', 'chat-1'))).toEqual({ replyChatId: 'chat-1', replyChannel: 'web', mode: 'interactive' });
            expect(await svc.route(msg('telegram', TG_OWNER))).toEqual({ replyChatId: TG_OWNER, replyChannel: 'telegram', mode: 'interactive' });
        });

        test("the owner's own WhatsApp chat answers in place; another assistant chat goes to the owner channel", async () => {
            expect(await svc.route(msg('whatsapp:assistant', OWNER_JID))).toMatchObject({ replyChatId: OWNER_JID, mode: 'interactive' });
            expect(await svc.route(msg('whatsapp:assistant', '200000000000002@lid'))).toMatchObject({ replyChatId: '200000000000002@lid', mode: 'interactive' });
            expect(await svc.route(msg('whatsapp:assistant', '15550001234@s.whatsapp.net')))
                .toEqual({ replyChatId: OWNER_JID, replyChannel: 'whatsapp', mode: 'deferred', ownerChannel: true });
        });

        test('scheduler, system and watcher runs go to the owner channel, keyed by the owner', async () => {
            expect(await svc.route(schedulerMsg())).toEqual({ replyChatId: OWNER_JID, replyChannel: 'whatsapp', mode: 'deferred', ownerChannel: true });
            expect(await svc.route(msg('scheduler', 'system_dream_1700000000000', 'System Maintenance'))).toMatchObject({ replyChatId: OWNER_JID, mode: 'deferred' });
            // A watcher run happens in the contact's chat; the contact must never be asked.
            expect(await svc.route(watcherMsg())).toMatchObject({ replyChatId: OWNER_JID, mode: 'deferred' });
        });

        test('a job created from a web chat still asks on the owner channel, with a copy in that web chat', async () => {
            const job = msg('web', 'web-chat-7', 'Scheduled Task: set the AC', { jobName: 'ac-morning' });
            expect(await svc.route(job)).toEqual({
                replyChatId: OWNER_JID, replyChannel: 'whatsapp', mode: 'deferred', ownerChannel: true,
                mirror: { channel: 'web', chatId: 'web-chat-7' }
            });
            // A system run in a synthetic chat has nothing to mirror.
            expect(await svc.route(msg('system', 'system_dream_1700000000000', 'System Maintenance'))).not.toHaveProperty('mirror');
        });

        test('notification_channel telegram sends the card to Telegram', async () => {
            agent.settings.notification_channel = 'telegram';
            expect(await svc.route(schedulerMsg())).toMatchObject({ replyChatId: TG_OWNER, replyChannel: 'telegram', mode: 'deferred' });
        });

        test('sub-agents have no route; no owner channel is an error', async () => {
            expect(await svc.route(msg('subagent', 'subagent-1', 'x', { isSubAgent: true, parentChatId: 'chat-1' }))).toEqual({ error: 'sub-agent' });
            agent.settings = {};
            delete process.env.ALLOWED_TELEGRAM_IDS;
            delete process.env.MY_PHONE;
            expect((await svc.route(schedulerMsg())).error).toMatch(/owner_phone/);
        });
    });

    describe('request', () => {
        test('an interactive chat gets the card in place through the ledger and the row is keyed by that chat', async () => {
            const res = await svc.request({ message: msg('web', 'chat-1'), toolName: 'commitAndPush', args: { message: 'feat: x' }, reason: 'Pushing code.' });
            expect(res.paused).toBe(true);
            expect(res.delivered).toBe(true);
            expect(res.result.info).toMatch(/Action PAUSED/);
            expect(res.result.info).toMatch(new RegExp(`id ${res.id}`));
            expect(res.result.info).toMatch(/do not retry/);
            const row = db.getPendingConfirmation(res.id);
            expect(row).toMatchObject({ mode: 'interactive', reply_chat_id: 'chat-1', reply_channel: 'web', origin_chat_id: 'chat-1', tool_name: 'commitAndPush', status: 'pending' });
            expect(row.args).toEqual({ message: 'feat: x' });
            const sent = sentTexts(agent);
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ source: 'web', metadata: { chatId: 'chat-1', approval: { id: res.id, status: 'pending', toolName: 'commitAndPush' } } });
            expect(sent[0].content).toContain('Approval needed');
            expect(sent[0].content).toContain('commitAndPush');
            expect(sent[0].content).toContain(`/confirm ${res.id}`);
            expect(db.getOutboxRow(sent[0].id)).toMatchObject({ kind: 'approval', status: 'sent', origin: `approval:${res.id}` });
            expect(agent.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval' }));
            expect(agent.interface.broadcast).toHaveBeenCalledWith('agent:approval', expect.objectContaining({ id: res.id, status: 'pending' }));
        });

        test('a scheduled run sends the card to the owner channel with the job named, and a 6 h expiry', async () => {
            const res = await svc.request({ message: schedulerMsg('morning'), toolName: 'sendEmail', args: { to: 'alice@example.com', subject: 'Hi', password: 'x' }, reason: 'Email.' });
            expect(res.paused).toBe(true);
            const row = db.getPendingConfirmation(res.id);
            expect(row).toMatchObject({ mode: 'deferred', reply_chat_id: OWNER_JID, reply_channel: 'whatsapp', origin_source: 'scheduler' });
            expect(row.origin_meta).toEqual({ jobName: 'morning' });
            const ttl = new Date(row.expires_at).getTime() - Date.now();
            expect(ttl).toBeGreaterThan(5.9 * 3600e3);
            expect(ttl).toBeLessThanOrEqual(6 * 3600e3);
            const sent = sentTexts(agent)[0];
            expect(sent.source).toBe('whatsapp');
            expect(sent.metadata.chatId).toBe(OWNER_JID);
            expect(sent.metadata.session).toBe('assistant');
            expect(sent.content).toContain('scheduled job "morning"');
            expect(sent.content).toContain('password: <redacted>');
            expect(sent.content).not.toContain('"x"');
            expect(res.result.info).toMatch(/notification channel/);
        });

        test('a job from a web chat: the card goes to the owner channel, a copy to the web chat, and the row is keyed by the owner', async () => {
            const job = msg('web', 'web-chat-7', 'Scheduled Task: set the AC', { jobName: 'ac-morning' });
            const res = await svc.request({ message: job, toolName: 'sendEmail', args: { to: 'alice@example.com' }, reason: 'Email.' });
            expect(res.result.info).toMatch(/notification channel/);
            const row = db.getPendingConfirmation(res.id);
            expect(row).toMatchObject({ mode: 'deferred', reply_chat_id: OWNER_JID, reply_channel: 'whatsapp', origin_chat_id: 'web-chat-7', origin_source: 'web' });
            const ttl = new Date(row.expires_at).getTime() - Date.now();
            expect(ttl).toBeGreaterThan(5.9 * 3600e3);
            const sent = sentTexts(agent);
            expect(sent).toHaveLength(2);
            expect(sent[0]).toMatchObject({ source: 'whatsapp', metadata: { chatId: OWNER_JID, session: 'assistant' } });
            expect(sent[0].content).toContain('scheduled job "ac-morning"');
            expect(sent[1]).toMatchObject({ source: 'web', metadata: { chatId: 'web-chat-7', approval: { id: res.id, status: 'pending', mirror: true } } });
            expect(sent[1].content).toContain('Asked on your whatsapp too');
            expect(sent[1].content).toContain(`/confirm ${res.id}`);
        });

        test('a watcher run asks the owner, never the contact', async () => {
            const res = await svc.request({ message: watcherMsg(), toolName: 'sendMessage', args: { to: '15550001234', content: 'hi' }, reason: 'First contact.' });
            const sent = sentTexts(agent);
            expect(sent).toHaveLength(1);
            expect(sent[0].metadata.chatId).toBe(OWNER_JID);
            expect(sent[0].content).toContain('watcher run');
            expect(db.getPendingConfirmation(res.id).reply_chat_id).toBe(OWNER_JID);
        });

        test('interactive rows expire after 30 minutes by default; the approvals setting changes both TTLs', async () => {
            let res = await svc.request({ message: msg('web', 'c'), toolName: 'deleteVault', args: { id: 'v' }, reason: 'r' });
            let ttl = new Date(db.getPendingConfirmation(res.id).expires_at).getTime() - Date.now();
            expect(ttl).toBeGreaterThan(29 * 60e3);
            expect(ttl).toBeLessThanOrEqual(30 * 60e3);
            db.setAgentSetting('approvals', { ttlInteractiveMin: 5, ttlDeferredHours: 1 });
            res = await svc.request({ message: msg('web', 'c2'), toolName: 'deleteVault', args: { id: 'v' }, reason: 'r' });
            ttl = new Date(db.getPendingConfirmation(res.id).expires_at).getTime() - Date.now();
            expect(ttl).toBeLessThanOrEqual(5 * 60e3);
            res = await svc.request({ message: schedulerMsg(), toolName: 'deleteVault', args: { id: 'v' }, reason: 'r' });
            ttl = new Date(db.getPendingConfirmation(res.id).expires_at).getTime() - Date.now();
            expect(ttl).toBeLessThanOrEqual(3600e3);
        });

        test('a sub-agent is told to report to the parent and nothing is stored', async () => {
            const res = await svc.request({ message: msg('subagent', 'subagent-1', 'x', { isSubAgent: true, parentChatId: 'chat-1' }), toolName: 'sendEmail', args: {}, reason: 'r' });
            expect(res.paused).toBe(false);
            expect(res.result.error).toMatch(/report to the parent/);
            expect(db.listPendingConfirmations()).toHaveLength(0);
            expect(agent.interface.send).not.toHaveBeenCalled();
        });

        test('with no owner channel the action is denied, not run', async () => {
            agent.settings = {};
            delete process.env.ALLOWED_TELEGRAM_IDS;
            delete process.env.MY_PHONE;
            const res = await svc.request({ message: schedulerMsg(), toolName: 'sendEmail', args: {}, reason: 'r' });
            expect(res.paused).toBe(false);
            expect(res.result.error).toMatch(/no channel can reach him/);
        });

        test('a refused send is queued by the ledger and the model is told delivery is retried', async () => {
            agent.interface.send.mockResolvedValue(false);
            const res = await svc.request({ message: schedulerMsg(), toolName: 'sendEmail', args: {}, reason: 'r' });
            expect(res.paused).toBe(true);
            expect(res.delivered).toBe(false);
            expect(res.result.info).toMatch(/delivery is being retried/);
            const outbox = db.listRecentOutbox({ limit: 5 });
            expect(outbox[0]).toMatchObject({ kind: 'approval', status: 'failed' });
        });

        test('the card lists other pending ids in the same chat', async () => {
            const a = await svc.request({ message: msg('web', 'c'), toolName: 'deleteVault', args: { id: 'v' }, reason: 'r' });
            const b = await svc.request({ message: msg('web', 'c'), toolName: 'commitAndPush', args: { message: 'm' }, reason: 'r' });
            const second = sentTexts(agent)[1];
            expect(second.content).toContain(`Also pending here: ${a.id} (deleteVault)`);
            expect(second.content).toContain(`/confirm ${b.id}`);
        });
    });

    describe('answers', () => {
        test('the strict vocabulary', () => {
            for (const w of ['yes', 'Yes!', ' si ', 'Sí.', 'ok', 'OK', 'dale', 'approve', 'confirm', '"yes"', 'go ahead']) expect(decisionWord(w)).toBe('approved');
            for (const w of ['no', 'No.', 'cancel', 'deny', 'cancelar', 'nope']) expect(decisionWord(w)).toBe('denied');
            for (const w of ['yes please send it', 'maybe', 'hola', '1234', 'ok then what about tomorrow', '']) expect(decisionWord(w)).toBeNull();
        });

        test('a plain yes with one interactive approval pending hands the stored call back to the run', async () => {
            const req = await svc.request({ message: msg('web', 'chat-1'), toolName: 'commitAndPush', args: { message: 'feat: x' }, reason: 'r' });
            const send = jest.fn().mockResolvedValue(true);
            const res = await svc.intercept(msg('web', 'chat-1', 'yes'), send);
            expect(res).toEqual({ handled: false, row: expect.any(Object), execute: { name: 'commitAndPush', args: { message: 'feat: x' }, approvalId: req.id } });
            expect(db.getPendingConfirmation(req.id)).toMatchObject({ status: 'approved', decided_via: 'chat' });
            expect(agent._executeTool).not.toHaveBeenCalled(); // processMessage runs it as EXECUTE_PENDING
        });

        test('a plain no denies and replies; a second answer is told it was decided', async () => {
            const req = await svc.request({ message: msg('web', 'chat-1'), toolName: 'commitAndPush', args: {}, reason: 'r' });
            const send = jest.fn().mockResolvedValue(true);
            const res = await svc.intercept(msg('web', 'chat-1', 'no'), send);
            expect(res.handled).toBe(true);
            expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: 'Denied: commitAndPush will not run.', metadata: { chatId: 'chat-1' } }));
            expect(db.getPendingConfirmation(req.id).status).toBe('denied');
            const again = await svc.handleCommand(msg('web', 'chat-1', `/confirm ${req.id}`), '/confirm', req.id, send);
            expect(again).toBe(true);
            expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringMatching(/already denied/) }));
        });

        test('with several pending, a plain yes falls through, a bare /confirm lists the ids and /confirm <id> picks one (prefix allowed)', async () => {
            const a = await svc.request({ message: msg('web', 'c'), toolName: 'deleteVault', args: { id: 'v' }, reason: 'r' });
            const b = await svc.request({ message: msg('web', 'c'), toolName: 'commitAndPush', args: { message: 'm' }, reason: 'r' });
            const send = jest.fn().mockResolvedValue(true);
            expect(await svc.intercept(msg('web', 'c', 'yes'), send)).toBeNull(); // the model gets it; the card asked for /confirm <id>
            expect(send).not.toHaveBeenCalled();
            expect(db.getPendingConfirmation(a.id).status).toBe('pending');
            const bare = await svc.handleCommand(msg('web', 'c', '/confirm'), '/confirm', undefined, send);
            expect(bare).toBe(true);
            const listed = send.mock.calls[0][0].content;
            expect(listed).toContain('2 approvals are pending');
            expect(listed).toContain(a.id);
            expect(listed).toContain(b.id);
            expect(db.getPendingConfirmation(b.id).status).toBe('pending');
            const picked = await svc.handleCommand(msg('web', 'c', `/confirm ${b.id.slice(0, 4)}`), '/confirm', b.id.slice(0, 4), send);
            expect(picked).toEqual({ type: 'EXECUTE_PENDING', action: { name: 'commitAndPush', args: { message: 'm' }, approvalId: b.id } });
            expect(db.getPendingConfirmation(a.id).status).toBe('pending');
            const cancelled = await svc.handleCommand(msg('web', 'c', `/cancel ${a.id}`), '/cancel', a.id, send);
            expect(cancelled).toBe(true);
            expect(db.getPendingConfirmation(a.id).status).toBe('denied');
        });

        test('/confirm with nothing pending and an unknown id both answer plainly', async () => {
            const send = jest.fn().mockResolvedValue(true);
            expect(await svc.handleCommand(msg('web', 'c', '/confirm'), '/confirm', undefined, send)).toBe(true);
            expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'No pending action to confirm.' }));
            expect(await svc.handleCommand(msg('web', 'c', '/cancel'), '/cancel', undefined, send)).toBe(true);
            expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'Action cancelled.' }));
            await svc.request({ message: msg('web', 'c'), toolName: 'deleteVault', args: {}, reason: 'r' });
            expect(await svc.handleCommand(msg('web', 'c', '/confirm zzzzzz'), '/confirm', 'zzzzzz', send)).toBe(true);
            expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringMatching(/No pending approval matches "zzzzzz"/) }));
            expect(await svc.handleCommand(msg('web', 'c', '/approvals'), '/approvals', undefined, send)).toBe(true);
            expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringMatching(/1 pending approval/) }));
        });

        test('a contact cannot answer an approval that went to the owner channel', async () => {
            await svc.request({ message: watcherMsg(), toolName: 'sendMessage', args: { to: '15550001234', content: 'hi' }, reason: 'r' });
            const send = jest.fn().mockResolvedValue(true);
            expect(await svc.intercept(msg('whatsapp:assistant', '15550001234@s.whatsapp.net', 'yes'), send)).toBeNull();
            expect(await svc.handleCommand(msg('whatsapp:assistant', '15550001234@s.whatsapp.net', '/confirm'), '/confirm', undefined, send)).toBe(true);
            expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'No pending action to confirm.' }));
            expect(db.listPendingConfirmations()).toHaveLength(1);
        });

        test("a plain yes/no counts only in the chat that holds the card; the owner's other chats need /confirm <id>", async () => {
            // A job's card went to the owner's WhatsApp.
            const req = await svc.request({ message: schedulerMsg('morning'), toolName: 'sendEmail', args: { to: 'alice@example.com' }, reason: 'r' });
            const send = jest.fn().mockResolvedValue(true);
            // "yes", "ok", "no" in a web chat or on Telegram answer whatever the model asked there, not the job.
            expect(await svc.intercept(msg('web', 'web-chat-77', 'yes'), send)).toBeNull();
            expect(await svc.intercept(msg('web', 'web-chat-77', 'ok'), send)).toBeNull();
            expect(await svc.intercept(msg('telegram', TG_OWNER, 'no'), send)).toBeNull();
            expect(send).not.toHaveBeenCalled();
            expect(agent._executeTool).not.toHaveBeenCalled();
            expect(db.getPendingConfirmation(req.id).status).toBe('pending');
            // A bare /cancel elsewhere ends nothing here.
            expect(await svc.handleCommand(msg('web', 'web-chat-99', '/cancel'), '/cancel', undefined, send)).toBe(true);
            expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringMatching(/^Action cancelled\. 1 approval\(s\) wait elsewhere/) }));
            expect(db.getPendingConfirmation(req.id).status).toBe('pending');
            // /approvals lists it from any owner chat; /confirm <id> decides it from any owner chat.
            await svc.handleCommand(msg('web', 'web-chat-77', '/approvals'), '/approvals', undefined, send);
            expect(send.mock.calls.at(-1)[0].content).toContain(req.id);
            const res = await svc.handleCommand(msg('web', 'web-chat-77', `/confirm ${req.id}`), '/confirm', req.id, send);
            expect(res).toBe(true);
            expect(db.getPendingConfirmation(req.id)).toMatchObject({ status: 'approved', decided_via: 'chat' });
            expect(agent._executeTool).toHaveBeenCalledTimes(1);
            expect(sentTexts(agent).pop()).toMatchObject({ source: 'web', metadata: { chatId: 'web-chat-77' } });
        });

        test('a plain yes in a mirrored web chat falls through; the web buttons send /confirm <id> and that works', async () => {
            const job = msg('web', 'web-chat-7', 'Scheduled Task: mail', { jobName: 'mail' });
            const req = await svc.request({ message: job, toolName: 'sendEmail', args: { to: 'alice@example.com' }, reason: 'r' });
            const send = jest.fn().mockResolvedValue(true);
            expect(await svc.intercept(msg('web', 'web-chat-7', 'yes'), send)).toBeNull();
            expect(db.getPendingConfirmation(req.id).status).toBe('pending');
            expect(await svc.handleCommand(msg('web', 'web-chat-7', `/cancel ${req.id}`), '/cancel', req.id, send)).toBe(true);
            expect(db.getPendingConfirmation(req.id).status).toBe('denied');
            expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: 'Denied: sendEmail will not run.' }));
        });

        test('non-vocabulary text and slash commands fall through (askUser and the model get them)', async () => {
            await svc.request({ message: msg('web', 'c'), toolName: 'deleteVault', args: {}, reason: 'r' });
            const send = jest.fn();
            expect(await svc.intercept(msg('web', 'c', 'what does this delete?'), send)).toBeNull();
            expect(await svc.intercept(msg('web', 'c', '/stop'), send)).toBeNull();
            expect(await svc.intercept(msg('web', 'c', '2'), send)).toBeNull();
            expect(send).not.toHaveBeenCalled();
            expect(await svc.intercept(msg('web', 'other-chat', 'yes'), send)).toBeNull();
        });
    });

    describe('deferred approvals run the stored call', () => {
        test("the owner's yes on WhatsApp runs the tool in the job's context and reports back", async () => {
            const req = await svc.request({ message: schedulerMsg('morning'), toolName: 'sendEmail', args: { to: 'alice@example.com' }, reason: 'r' });
            agent.interface.send.mockClear();
            const send = jest.fn().mockResolvedValue(true);
            const res = await svc.intercept(msg('whatsapp:assistant', OWNER_JID, 'yes'), send);
            expect(res.handled).toBe(true);
            expect(agent._executeTool).toHaveBeenCalledTimes(1);
            const [name, args, originMessage, relay, usage, options] = agent._executeTool.mock.calls[0];
            expect(name).toBe('sendEmail');
            expect(args).toEqual({ to: 'alice@example.com' });
            expect(originMessage).toMatchObject({ source: 'scheduler', metadata: { chatId: 'scheduled_morning_1700000000000', jobName: 'morning', approvalId: req.id } });
            expect(typeof relay).toBe('function');
            expect(usage).toBeNull();
            expect(options).toEqual({ approved: true });
            const row = db.getPendingConfirmation(req.id);
            expect(row.status).toBe('approved');
            expect(row.result).toEqual({ success: true, sent: 1 });
            // The result went to the chat the answer came from, through the ledger.
            const out = sentTexts(agent);
            expect(out).toHaveLength(1);
            expect(out[0]).toMatchObject({ source: 'whatsapp', metadata: { chatId: OWNER_JID, session: 'assistant', approval: { id: req.id, status: 'approved' } } });
            expect(out[0].content).toMatch(/Approved and done: sendEmail/);
            expect(db.getOutboxRow(out[0].id)).toMatchObject({ kind: 'approval', status: 'sent' });
        });

        test("the owner's LID id is the same WhatsApp chat; his Telegram needs the id", async () => {
            const req = await svc.request({ message: schedulerMsg(), toolName: 'sendEmail', args: {}, reason: 'r' });
            expect(await svc.pendingHere(msg('whatsapp:assistant', '200000000000002@lid', 'yes'))).toHaveLength(1);
            expect(await svc.pendingHere(msg('telegram', TG_OWNER, 'yes'))).toHaveLength(0);
            expect(await svc.pendingFor(msg('telegram', TG_OWNER, 'yes'))).toHaveLength(1);
            expect(await svc.pendingFor(msg('telegram', '999', 'yes'))).toHaveLength(0);
            const send = jest.fn().mockResolvedValue(true);
            expect(await svc.intercept(msg('telegram', TG_OWNER, 'ok'), send)).toBeNull();
            expect(db.getPendingConfirmation(req.id).status).toBe('pending');
            expect(await svc.handleCommand(msg('telegram', TG_OWNER, `/confirm ${req.id}`), '/confirm', req.id, send)).toBe(true);
            expect(db.getPendingConfirmation(req.id).status).toBe('approved');
            expect(agent._executeTool).toHaveBeenCalledTimes(1);
            expect(sentTexts(agent).pop()).toMatchObject({ source: 'telegram', metadata: { chatId: TG_OWNER } });
            // The LID chat is the owner's WhatsApp chat: a plain word works there.
            const again = await svc.request({ message: schedulerMsg('two'), toolName: 'sendEmail', args: {}, reason: 'r' });
            const res = await svc.intercept(msg('whatsapp:assistant', '200000000000002@lid', 'dale'), send);
            expect(res.handled).toBe(true);
            expect(db.getPendingConfirmation(again.id).status).toBe('approved');
        });

        test('a failing tool is reported as approved-but-failed and stored', async () => {
            agent._executeTool.mockRejectedValueOnce(new Error('smtp down'));
            const req = await svc.request({ message: schedulerMsg(), toolName: 'sendEmail', args: {}, reason: 'r' });
            const res = await svc.decide(req.id, 'approved', { via: 'web' });
            expect(res.handled).toBe(true);
            expect(res.result).toEqual({ error: 'smtp down' });
            expect(db.getPendingConfirmation(req.id).result).toEqual({ error: 'smtp down' });
            expect(sentTexts(agent).pop().content).toMatch(/Approved, but it failed: sendEmail/);
        });

        test('progress a tool sends while running is relayed to the owner', async () => {
            agent._executeTool.mockImplementationOnce(async (name, args, message, relay) => {
                await relay({ content: 'Working on it...' });
                return { ok: true };
            });
            const req = await svc.request({ message: schedulerMsg(), toolName: 'generateImage', args: { prompt: 'x' }, reason: 'r' });
            agent.interface.send.mockClear();
            await svc.decide(req.id, 'approved', { via: 'web' });
            const out = sentTexts(agent);
            expect(out[0].content).toBe('Working on it...');
            expect(out[1].content).toMatch(/Approved and done: generateImage/);
        });

        test('an interactive row decided from the settings card runs and reports in its origin chat', async () => {
            const req = await svc.request({ message: msg('web', 'chat-1'), toolName: 'commitAndPush', args: { message: 'm' }, reason: 'r' });
            agent.interface.send.mockClear();
            const res = await svc.decide(req.id, 'approved', { via: 'web' });
            expect(res.handled).toBe(true);
            expect(agent._executeTool).toHaveBeenCalledWith('commitAndPush', { message: 'm' }, expect.objectContaining({ source: 'web', metadata: expect.objectContaining({ chatId: 'chat-1' }) }), expect.any(Function), null, { approved: true });
            expect(sentTexts(agent)[0]).toMatchObject({ source: 'web', metadata: { chatId: 'chat-1' } });
            // Only the first decision wins.
            expect(await svc.decide(req.id, 'denied', { via: 'web' })).toMatchObject({ handled: false, status: 'approved' });
            expect(await svc.decide('nope00', 'approved', { via: 'web' })).toMatchObject({ handled: false, status: 'missing' });
        });
    });

    describe('coexistence with askUser', () => {
        test('while a question waits in the chat, yes/no belong to the question; afterwards they decide the approval', async () => {
            const ask = new AskUserService(agent);
            agent.askUser = ask;
            const chat = msg('web', 'chat-1');
            const req = await svc.request({ message: chat, toolName: 'deleteVault', args: { id: 'v' }, reason: 'r' });
            const pending = ask.ask(chat, { question: 'Also remove the index?', options: ['yes', 'no'], timeoutSeconds: 60 });
            await new Promise(r => setImmediate(r)); // ask() registers its wait after the card is sent
            const send = jest.fn().mockResolvedValue(true);

            // processMessage order: askUser first when a question is open here; approvals never take the word.
            expect(await svc.intercept(msg('web', 'chat-1', 'no'), send)).toBeNull();
            expect(db.getPendingConfirmation(req.id).status).toBe('pending');
            expect(await ask.intercept(msg('web', 'chat-1', 'no'), send)).toMatchObject({ content: 'Got it.' });
            await expect(pending).resolves.toEqual({ answer: 'no' });
            expect(ask.hasPending('chat-1')).toBe(false);

            const res = await svc.intercept(msg('web', 'chat-1', 'no'), send);
            expect(res.handled).toBe(true);
            expect(db.getPendingConfirmation(req.id).status).toBe('denied');
        });

        test("a question the owner is answering on WhatsApp shields a job's approval there too", async () => {
            const ask = new AskUserService(agent);
            agent.askUser = ask;
            const req = await svc.request({ message: schedulerMsg(), toolName: 'sendEmail', args: {}, reason: 'r' });
            const pending = ask.ask(schedulerMsg('other'), { question: 'Send the photo?', options: ['yes', 'no'], timeoutSeconds: 60 });
            await new Promise(r => setImmediate(r));
            const send = jest.fn().mockResolvedValue(true);
            expect(await svc.intercept(msg('whatsapp:assistant', OWNER_JID, 'yes'), send)).toBeNull();
            expect(await svc.intercept(msg('whatsapp:assistant', '200000000000002@lid', 'yes'), send)).toBeNull();
            expect(db.getPendingConfirmation(req.id).status).toBe('pending');
            expect(agent._executeTool).not.toHaveBeenCalled();
            ask.cancelAll();
            await expect(pending).resolves.toEqual({ cancelled: true });
        });
    });

    describe('deny-list', () => {
        test('settings patterns block in every mode with no card; the env fallback adds patterns', async () => {
            db.setAgentSetting('approvals', { deny: 'runShellCommand:*rm -rf*\ncommitAndPush' });
            let res = svc.check('runShellCommand', { command: 'rm -rf /tmp/x' });
            expect(res).toMatchObject({ denied: true, pattern: 'runShellCommand:*rm -rf*' });
            expect(res.message).toMatch(/deny-list/);
            expect(svc.check('commitAndPush', { message: 'x' }).denied).toBe(true);
            expect(svc.check('runShellCommand', { command: 'ls' })).toEqual({ requiresConfirmation: false });
            process.env.APPROVALS_DENY = 'sendMessage:*"session":"user"*; deleteVault';
            expect(svc.check('sendMessage', { to: '1', content: 'x', session: 'user' }).denied).toBe(true);
            expect(svc.check('deleteVault', { id: 'v' }).denied).toBe(true);
            expect(svc.settings().deny).toEqual(['runShellCommand:*rm -rf*', 'commitAndPush', 'sendMessage:*"session":"user"*', 'deleteVault']);
            expect(agent.interface.send).not.toHaveBeenCalled();
            expect(db.listPendingConfirmations()).toHaveLength(0);
        });

        test('rules still apply when nothing is denied', () => {
            expect(svc.check('sendEmail', { to: 'alice@example.com' })).toMatchObject({ requiresConfirmation: true, rule: 'email-send' });
            expect(svc.check('readFile', { path: 'a.txt' })).toEqual({ requiresConfirmation: false });
        });
    });

    describe('settings normalization', () => {
        test('defaults, clamps and deny parsing', () => {
            expect(normalizeApprovalSettings(undefined)).toEqual({ ttlInteractiveMin: 30, ttlDeferredHours: 6, deny: [] });
            expect(normalizeApprovalSettings({ ttlInteractiveMin: 0, ttlDeferredHours: -1 })).toMatchObject({ ttlInteractiveMin: 30, ttlDeferredHours: 6 });
            expect(normalizeApprovalSettings({ ttlInteractiveMin: 99999, ttlDeferredHours: 999 })).toMatchObject({ ttlInteractiveMin: 1440, ttlDeferredHours: 168 });
            expect(normalizeApprovalSettings({ ttlInteractiveMin: '15', ttlDeferredHours: '0.5', deny: ' a \n# note\n\nb;c ' }).deny).toEqual(['a', 'b', 'c']);
            expect(normalizeApprovalSettings({ deny: ['x', '', null] }).deny).toEqual(['x']);
        });

        test('summaries redact secrets and keep values short', () => {
            const s = summarizeArgs({ to: 'alice@example.com', apiKey: 'k', body: 'a'.repeat(500) });
            expect(s).toContain('to: "alice@example.com"');
            expect(s).toContain('apiKey: <redacted>');
            expect(s.length).toBeLessThanOrEqual(320);
            expect(summarizeArgs({})).toBe('(no arguments)');
        });
    });

    describe('expiry and restart', () => {
        test('the sweeper expires overdue rows and a late answer is told so', async () => {
            jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
            try {
                const quick = new ApprovalService(agent, { sweepMs: 1000 });
                const req = await quick.request({ message: msg('web', 'c'), toolName: 'deleteVault', args: {}, reason: 'r' });
                db.db.prepare('UPDATE pending_confirmations SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), req.id);
                quick.start();
                jest.advanceTimersByTime(1000);
                quick.stop();
                expect(db.getPendingConfirmation(req.id).status).toBe('expired');
                expect(agent.interface.broadcast).toHaveBeenCalledWith('agent:approval', expect.objectContaining({ id: req.id, status: 'expired' }));
                const send = jest.fn().mockResolvedValue(true);
                expect(await quick.intercept(msg('web', 'c', 'yes'), send)).toBeNull(); // nothing pending: falls through
                await quick.handleCommand(msg('web', 'c', `/confirm ${req.id}`), '/confirm', req.id, send);
                expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringMatching(/is already expired/) }));
            } finally {
                jest.useRealTimers();
            }
        });

        test('an overdue row not yet swept cannot be approved from the settings card or by id; it is marked expired', async () => {
            const req = await svc.request({ message: msg('web', 'c'), toolName: 'deleteVault', args: {}, reason: 'r' });
            db.db.prepare('UPDATE pending_confirmations SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), req.id);
            const res = await svc.decide(req.id, 'approved', { via: 'web' });
            expect(res).toMatchObject({ handled: false, status: 'expired' });
            expect(res.error).toMatch(/already expired/);
            expect(agent._executeTool).not.toHaveBeenCalled();
            expect(db.getPendingConfirmation(req.id)).toMatchObject({ status: 'expired', decided_via: 'sweeper' });
            const send = jest.fn().mockResolvedValue(true);
            await svc.handleCommand(msg('web', 'c', `/confirm ${req.id}`), '/confirm', req.id, send);
            expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringMatching(/is already expired/) }));
        });

        test('rows survive a restart: a new service on the same DB still finds and decides them', async () => {
            const req = await svc.request({ message: schedulerMsg(), toolName: 'sendEmail', args: { to: 'a@example.com' }, reason: 'r' });
            db.close();
            db = new AgentDB(dir);
            agent = makeAgent(db);
            svc = new ApprovalService(agent);
            expect(svc.loadOnBoot()).toBe(1);
            const send = jest.fn().mockResolvedValue(true);
            const res = await svc.intercept(msg('whatsapp:assistant', OWNER_JID, 'dale'), send);
            expect(res.handled).toBe(true);
            expect(agent._executeTool).toHaveBeenCalledWith('sendEmail', { to: 'a@example.com' }, expect.any(Object), expect.any(Function), null, { approved: true });
            expect(db.getPendingConfirmation(req.id).status).toBe('approved');
        });

        test('list() feeds the settings card', async () => {
            const req = await svc.request({ message: msg('web', 'c'), toolName: 'deleteVault', args: {}, reason: 'r' });
            const view = svc.list();
            expect(view.pending.map(r => r.id)).toEqual([req.id]);
            expect(view.recent).toHaveLength(1);
            expect(view.counts).toEqual({ pending: 1, approved: 0, denied: 0, expired: 0 });
            expect(view.settings).toMatchObject({ ttlInteractiveMin: 30, ttlDeferredHours: 6 });
        });

        test('a DB without the store denies instead of crashing', async () => {
            const bare = new ApprovalService({ db: {}, settings: {}, interface: { send: jest.fn() } });
            expect(await bare.intercept(msg('web', 'c', 'yes'), jest.fn())).toBeNull();
            const res = await bare.request({ message: msg('web', 'c'), toolName: 'x', args: {}, reason: 'r' });
            expect(res.paused).toBe(false);
            expect(res.result.error).toMatch(/store is unavailable/);
            expect(bare.loadOnBoot()).toBe(0);
        });
    });
});
