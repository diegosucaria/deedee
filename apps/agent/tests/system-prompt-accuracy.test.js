/**
 * The system instruction against the code it describes. Every check here
 * answers a line that was wrong: a parameter, a tool, a page or a folder the
 * prompt named that the code does not have, or two rules that gave opposite
 * orders.
 */
jest.mock('axios');
const fs = require('fs');
const path = require('path');
const { getSystemInstruction } = require('../src/prompts/system');
const { getLiveSystemInstruction } = require('../src/prompts/live');
const { toolDefinitions } = require('../src/tools-definition');

const decls = toolDefinitions.flatMap(t => t.functionDeclarations || []);
const decl = (name) => decls.find(d => d.name === name);
const notificationContext = { ownerName: 'Sam', ownerPhone: '+15550100', notificationChannel: 'whatsapp' };
const full = getSystemInstruction('T', '', 'FACTS', { codingMode: true, dynamicInTurn: true, browserSecretNames: [], notificationContext });
const light = (extra = {}) => getSystemInstruction('T', '', '', { isLightweight: true, browserSecretNames: ['SITE_USER'], ...extra });

describe('names the prompt uses exist in the code', () => {
    test('replyWithAudio takes languageCode', () => {
        expect(Object.keys(decl('replyWithAudio').parameters.properties)).toContain('languageCode');
        expect(full).toContain("set 'languageCode'");
        expect(full).not.toContain("the 'language' parameter");
    });
    test('the record-photo rule names real DJ tools; add_vinyl reads the attached photo and search_vinyls takes a list', () => {
        expect(full).toContain("'add_vinyl'");
        expect(full).toContain("'search_vinyls'");
        expect(decl('add_vinyl').description).toMatch(/photo\(s\) on the owner's current message/);
        expect(decl('add_vinyl').description).toMatch(/a contact's or a group's photo is never read/);
        expect(decl('add_vinyl').parameters.required).toEqual([]);
        expect(Object.keys(decl('search_vinyls').parameters.properties)).toEqual(expect.arrayContaining(['query', 'queries']));
        expect(decl('search_vinyls').parameters.required).toEqual([]);
    });

    test('every tool the prompt names in quotes is declared', () => {
        const named = [...full.matchAll(/'([a-z][A-Za-z]+(?:_[a-z]+)*)'/g)].map(m => m[1])
            .filter(n => /[A-Z_]/.test(n) && !['es-419', 'en-US'].includes(n));
        // Home Assistant's own tool and the browser tools come from MCP servers, not from this file.
        const mcp = new Set(['ha_call_service', 'browser_snapshot', 'browser_take_screenshot', 'browser_wait_for', 'browser_tabs', 'browser_navigate_back', 'work_calendar', 'calendarList', 'ios_shortcut']);
        // Two quoted names are parameters; they must be real ones.
        const params = { languageCode: 'replyWithAudio', expiresAt: 'scheduleJob' };
        for (const [param, tool] of Object.entries(params)) expect(Object.keys(decl(tool).parameters.properties)).toContain(param);
        const missing = [...new Set(named)].filter(n => !decl(n) && !mcp.has(n) && !params[n]);
        expect(missing).toEqual([]);
    });

    test('the calendar rules name the real call shape, not a tool that never existed', () => {
        expect(full).not.toContain('calendar_list');
        expect(full).toContain("resource: 'calendarList'");
        expect(full).toContain('calendarId');
        // The two rules code does not enforce stay as they were.
        expect(full).toContain("**Exclude Colleagues**: DO NOT query colleagues' individual calendars");
        expect(full).toContain('**Deduplication**');
    });

    test('the repo map lists every app and package on disk', () => {
        const root = path.join(__dirname, '../../..');
        const dirs = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => `${d}/${e.name}`);
        for (const dir of [...dirs('apps'), ...dirs('packages')]) expect(full).toContain(dir);
        // The map line itself, not another line that happens to name a folder.
        expect(full).toContain('apps/agent (the brain)');
        expect(full).toContain('apps/interfaces (WhatsApp, Telegram, Slack)');
        expect(full).not.toContain('tools/definition.js');
        // The checklist points at the rules file that exists; the two others only point to it.
        expect(full).toContain('Update "AGENTS.md"');
        expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
        for (const pointer of ['GEMINI.md', 'CLAUDE.md']) expect(fs.readFileSync(path.join(root, pointer), 'utf8')).toContain('AGENTS.md');
        expect(full).toContain('apps/agent/src/tools-definition.js');
    });

    test('browser secrets are added on the Brain page, and no rule names a tool that is never declared', () => {
        expect(full).not.toContain('Settings > Browser secrets');
        expect(full).toContain('/brain?tab=secrets');
        expect(light({ browserSecretNames: [] })).toContain('/brain?tab=secrets');
        expect(full).not.toContain('browser_close');
    });
});

describe('rules that gave opposite orders', () => {
    test('a reminder goes to the tool that sends it, not to a job that repeats for ever', () => {
        for (const name of ['setReminder', 'scheduleJob', 'scheduleTask']) expect(decl(name)).toBeTruthy();
        expect(full).toContain("'setReminder' for a one-time reminder");
        expect(full).toContain("'expiresAt'");
        expect(full).toContain("'scheduleTask' when something must be done");
        expect(full).not.toContain("Use 'scheduleJob' for reminders");
        expect(full).not.toContain("Reminders in general → use 'scheduleJob'");
    });

    test('audio: the block added for the turn wins, and the tool description agrees', () => {
        expect(full).not.toContain('This is NOT optional');
        expect(full).not.toContain('Text Triggers');
        expect(full).toContain('If an **OUTPUT RESTRICTION** block appears later in this prompt, follow it.');
        const description = decl('replyWithAudio').description;
        expect(description).not.toMatch(/FAIL/);
        expect(description).toContain('OUTPUT RESTRICTION');
    });

    test('code changes: his request is his approval, as everywhere else', () => {
        expect(full).not.toContain('getting confirmation');
        expect(full).not.toContain('approved Goal');
        expect(full).toContain('do not wait for a second yes');
        expect(full).toContain("'commitAndPush' opens a pull request");
    });

    test('pullLatestChanges says what it does to uncommitted edits, in the rule and in the tool', () => {
        expect(full).not.toContain("ALWAYS call 'pullLatestChanges'");
        expect(full).toContain('edits to tracked files that you have not committed are lost (new files stay)');
        expect(decl('pullLatestChanges').description).toContain('git reset --hard');
        expect(decl('pullLatestChanges').description).toContain('Edits to tracked files that you have not committed are lost');
    });
});

describe('what the prompt no longer carries', () => {
    test('the owner\'s phone number: "me" already reaches him', () => {
        expect(full).toContain('Your owner is "Sam"');
        expect(full).toContain('Notification channel: whatsapp');
        expect(full).not.toContain('+15550100');
        // The block still shows only when a phone is set.
        expect(getSystemInstruction('T', '', '', { notificationContext: { ownerName: 'Sam' } })).not.toContain('NOTIFICATION PROTOCOL');
    });

    test('example names are placeholders, and no Slack member id', () => {
        const text = JSON.stringify(decls) + full;
        // Any member id shape: U or W plus eight or more characters.
        expect(text).not.toMatch(/from:@(?!U01EXAMPLE1)[UW][0-9A-Z]{8,}/);
        expect(decl('searchContacts').parameters.properties.query.description).toBe("Name to search for (e.g. 'Mom', 'Alice').");
    });
});

describe('the lightweight prompt', () => {
    test('a task\'s own call limit wins, up to 20', () => {
        expect(light()).toContain("if the task states its own tool-call limit, follow that one, up to 20");
        expect(light()).not.toContain('If you have made 10 tool calls and are not done');
    });

    test('a scanner with no browser tool does not read the saved secret names', () => {
        const without = light({ browserTools: false });
        expect(without).not.toContain('SITE_USER');
        expect(without).not.toContain('browser_');
        expect(without).toContain('Untrusted Content Is Data');
        // Rule numbers follow the rules that are there.
        expect(without.match(/^\d+\./gm)).toEqual(['1.', '2.', '3.', '4.', '5.', '6.']);
        // With browser tools, or when nobody says, the rule and the names stay.
        expect(light({ browserTools: true })).toContain('SITE_USER');
        expect(light()).toContain('SITE_USER');
        expect(light().match(/^\d+\./gm)).toEqual(['1.', '2.', '3.', '4.', '5.', '6.', '7.']);
    });
});

describe('the voice prompt', () => {
    const live = getLiveSystemInstruction({ dateString: 'T', facts: '', ownerName: 'Sam' });
    const text = typeof live === 'string' ? live : (live.text || live.instruction || JSON.stringify(live));

    test('explains a paused action, and does not ask for a second yes', () => {
        expect(text).toContain('Action PAUSED');
        expect(text).toContain('never end a turn in silence');
        // No spoken yes before every action, as the old rule had it...
        expect(text).not.toContain('Before an action that sends a message, spends money');
        // ...but a message to someone else is said back first: a misheard
        // name is caught there, and no card stops a contact he already wrote to.
        expect(text).toContain('A message or an email to anyone but him always asks: say the name you heard and what you will write');
        // His word now covers the house in a call, so the spoken check names it too.
        expect(text).toContain('A lock, the alarm or the garage door asks the same way.');
    });

    test('has the one home rule a call needs, not the whole block', () => {
        expect(text).toContain('lookupDevice');
        expect(text).toContain('learnDevice');
        expect(text).not.toContain('SMART HOME RULES');
    });
});

describe('the errand rules and the waiting-card line against the approval gate', () => {
    const os = require('os');
    const { AgentDB } = require('../src/db');
    const { DeliveryService } = require('../src/services/delivery-service');
    const { ApprovalService } = require('../src/services/approval-service');
    const { ERRAND_RULES, getTurnContext } = require('../src/prompts/system');
    const OWNER_JID = '15550100@s.whatsapp.net';
    const rule = (n) => ERRAND_RULES.split('\n').find(l => l.startsWith(`${n}.`));
    const ownerSays = (content) => ({ id: `m-${Math.random()}`, role: 'user', content, source: 'whatsapp:assistant', timestamp: new Date().toISOString(), metadata: { chatId: OWNER_JID } });
    const ACCEPT = { toolName: 'answerErrand', args: { id: 7, action: 'accept', date: '2026-10-08', time: '10:30' } };
    const errandRun = { role: 'user', content: 'ERRAND 7', source: 'errand', metadata: { chatId: 'errand_7', errandId: 7 } };

    // A real gate on a real database in a temp folder.
    async function withGate(fn) {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-prompt-card-'));
        const db = new AgentDB(dir);
        try {
            const agent = {
                db, settings: { owner_phone: '+15550100' }, notifications: { create: jest.fn() },
                interface: { send: jest.fn().mockResolvedValue(true), broadcast: jest.fn().mockResolvedValue(true) },
                _executeTool: jest.fn().mockResolvedValue({ success: true }),
                _getOwnerWaIds: jest.fn().mockResolvedValue(new Set([OWNER_JID]))
            };
            agent.delivery = new DeliveryService(agent);
            const svc = new ApprovalService(agent);
            await fn({ db, agent, svc });
        } finally {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
            jest.restoreAllMocks();
        }
    }

    test('errand rule 4 gives no bare "sí" as an answer to act on', () => {
        expect(rule(4)).not.toMatch(/"s[ií]"/i);
        expect(rule(4)).toContain('his bare yes or no sends nothing through you');
    });

    test('errand rules 1, 3, 4 and 6 say what the gate and the errand service do now', () => {
        expect(rule(1)).toContain("A second 'startErrand' for the same person within minutes is refused and returns what already went out: tell him what went out, and do not retry.");
        expect(rule(3)).toContain('send=true, and text set to that exact draft. A draft he saw in the last 30 minutes goes out as it is, even while a card waits in his chat.');
        expect(rule(4)).toContain('His replies to a card in his chat are read for him: a clear yes or no to that card decides it before it reaches you.');
        expect(rule(6)).toContain('A message the check holds back goes nowhere: it comes to him as a card with the exact text, and his yes on that card sends it.');
    });

    test('a card his short word did not decide: calling its tool again does not answer it, and nothing that writes runs', () => withGate(async ({ db, agent, svc }) => {
        const card = await svc.request({ message: errandRun, ...ACCEPT, reason: 'r' });
        // Deedee asks him something else after the card; his "sí" may answer that.
        db.saveMessage({ id: 'q-after', role: 'assistant', content: '¿Apago las luces?', source: 'whatsapp:assistant', chatId: OWNER_JID, timestamp: new Date(Date.now() + 1000).toISOString(), metadata: { chatId: OWNER_JID } });
        const yes = { ...ownerSays('sí'), id: 'yes-1' };
        expect(await svc.intercept(yes, jest.fn())).toBeNull();
        const line = getTurnContext({ dateString: 'T', waitingCard: svc.undecidedCard(yes) });
        expect(line).toContain(`A CARD WAITS IN THIS CHAT: ${card.id} (answerErrand)`);
        expect(line).toContain('calling its tool again does not answer it, and nothing that writes to anyone runs on his short word, except an errand draft he saw before it.');
        const review = (c) => svc.review({ message: yes, ...c, historyUntrusted: false, foreignText: false });
        const again = await review(ACCEPT);
        expect(again.run).toBe(false);
        expect(db.getPendingConfirmation(card.id).status).toBe('pending');
        expect((await review({ toolName: 'sendMessage', args: { to: '+15550101', content: 'dale', session: 'user' } })).run).toBe(false);
        expect(agent._executeTool).not.toHaveBeenCalled();
    }));

    test('rule 4 against the gate: his own words to the card are read for him and decide it before the model', () => withGate(async ({ db, agent, svc }) => {
        const card = await svc.request({ message: errandRun, ...ACCEPT, reason: 'r', card: { question: '¿Le acepto a Alice el jueves 08/10 a las 10:30?', lang: 'es' } });
        svc.guardian = { readReply: jest.fn().mockResolvedValue({ answer: 'yes', reason: 'He says yes to 10:30.', failed: false }) };
        const res = await svc.intercept(ownerSays('aceptale las 10:30'), jest.fn());
        expect(res.handled).toBe(true);
        expect(db.getPendingConfirmation(card.id).status).toBe('approved');
        expect(agent._executeTool).toHaveBeenCalledWith('answerErrand', ACCEPT.args, expect.anything(), expect.any(Function), null, { approved: true });
    }));
});

describe('the errand rules against the real errand service', () => {
    const os = require('os');
    const axios = require('axios');
    const { AgentDB } = require('../src/db');
    const { ApprovalService } = require('../src/services/approval-service');
    const { ErrandService } = require('../src/services/errands');
    const { ErrandsExecutor } = require('../src/executors/errands');
    const OWNER = '5490000000001';
    const OWNER_CHAT = `${OWNER}@s.whatsapp.net`;
    const CONTACT = '5490000000002';
    const CONTACT_JID = `${CONTACT}@s.whatsapp.net`;
    const DRAFT = 'llego 10 minutos tarde';
    let dir, db, agent, approvals, service, executor, chat, sends, checkMessage;

    const ownerSays = (content, at = Date.now()) => ({ id: `m-${Math.random()}`, role: 'user', content, source: 'whatsapp', timestamp: new Date(at).toISOString(), metadata: { chatId: OWNER_CHAT } });
    const run = (name, args, message) => executor.execute(name, args, { message, approved: false, ownerTyped: true });
    const gate = (message, toolName, args) => approvals.review({ message, toolName, args, historyUntrusted: false, foreignText: false });

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        delete process.env.ERRANDS;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-prompt-errand-'));
        db = new AgentDB(dir);
        db.init();
        db.setAgentSetting('owner_phone', OWNER);
        sends = [];
        // He wrote to Alice before: the first message needs no card for that.
        chat = [{ role: 'assistant', content: 'hola, todo bien?', timestamp: Date.now() - 7 * 24 * 3600e3, id: 'H1', fromMe: true }];
        axios.get.mockImplementation(async (url) => {
            if (url.endsWith('/whatsapp/history')) return { data: chat };
            if (url.endsWith('/whatsapp/resolve')) return { data: { phoneJid: CONTACT_JID, lid: null, name: 'Alice', allJids: [CONTACT_JID] } };
            if (url.endsWith('/whatsapp/style-stats')) return { data: { n: 0 } };
            if (url.endsWith('/whatsapp/status')) return { data: { assistant: { me: { id: '5490000000007' }, allowedNumbers: [OWNER] }, user: { me: { id: OWNER }, allowedNumbers: [] } } };
            throw new Error(`unexpected GET ${url}`);
        });
        agent = {
            db,
            client: { models: { generateContent: jest.fn(async () => ({ text: JSON.stringify({ text: DRAFT, date: '', time: '' }), usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })) } },
            interface: {
                broadcast: jest.fn().mockResolvedValue(true),
                send: jest.fn(async (payload) => {
                    payload.sentMessageId = `W${sends.length + 1}`;
                    sends.push(payload);
                    chat.push({ role: 'assistant', content: payload.content, timestamp: Date.now(), id: payload.sentMessageId, fromMe: true });
                    return true;
                })
            },
            delivery: {
                resolveOwnerTarget: () => ({ channel: 'whatsapp', target: OWNER_CHAT }),
                isOwnerTarget: (channel, target) => String(target || '').replace(/@.*$/, '') === OWNER,
                deliver: jest.fn().mockResolvedValue({ delivered: true })
            },
            notifications: { create: jest.fn() },
            _getOwnerWaIds: async () => new Set([OWNER_CHAT]),
            _ownerTyped: async (m) => m?.source === 'whatsapp' && !m?.metadata?.jobName && m?.metadata?.chatId === OWNER_CHAT
        };
        approvals = new ApprovalService(agent);
        agent.approvals = approvals;
        // The message check passes unless a test says otherwise.
        checkMessage = jest.fn().mockResolvedValue({ ok: true, reason: '', failed: false });
        approvals.guardian = { checkMessage, readReply: jest.fn().mockResolvedValue({ answer: 'other', reason: '', failed: false }) };
        service = new ErrandService(agent, { partGapMs: 0, bufferMs: 5 });
        agent.errands = service;
        executor = new ErrandsExecutor({ agent });
    });

    afterEach(() => {
        service.stop();
        approvals.stop();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    test('rule 1: two starts in one turn send one message; the second is refused and names what went out', async () => {
        const origin = ownerSays('decile a Alice que llego 10 minutos tarde');
        const args = { contact: CONTACT, goal: 'tell', request: 'que llego 10 minutos tarde' };
        const [a, b] = await Promise.all([
            service.start(args, { originMessage: origin, runId: 'run-1' }),
            service.start(args, { originMessage: origin, runId: 'run-1' })
        ]);
        expect(sends.map(m => m.content)).toEqual([DRAFT]);
        const refused = [a, b].find(r => r.success === false);
        expect(refused).toBeTruthy();
        expect(JSON.stringify(refused)).toContain(DRAFT);
        expect(refused.error).toMatch(/Nothing (?:more )?was sent/);
    });

    // A job's card waits in his chat, and he asks for a draft first.
    async function jobCardThenDraft() {
        const job = await approvals.request({ message: { source: 'scheduler', metadata: { jobName: 'facturas', chatId: 'scheduled_facturas' } }, toolName: 'sendEmail', args: { to: 'user@example.com', subject: 'x' }, reason: 'r' });
        const args = { contact: CONTACT, goal: 'tell', request: 'que llego 10 minutos tarde', send: false };
        const draft = await run('startErrand', args, ownerSays('decile a Alice que llego 10 minutos tarde, no lo mandes todavía'));
        expect(draft).toMatchObject({ success: true, sent: false, draft: DRAFT });
        db.saveMessage({ id: 'shown', role: 'assistant', content: `Le mandaría a Alice: "${DRAFT}". ¿Lo mando?`, source: 'whatsapp', chatId: OWNER_CHAT, timestamp: new Date(Date.now() + 1).toISOString(), metadata: { chatId: OWNER_CHAT } });
        return { job, sendArgs: { ...args, send: true, text: DRAFT } };
    }

    test('rule 3: "dale, mandalo" sends the draft he saw as it is, while a job card waits, with no second check', async () => {
        const { job, sendArgs } = await jobCardThenDraft();
        checkMessage.mockClear();
        const yes = ownerSays('dale, mandalo', Date.now() + 5);
        expect(await approvals.intercept(yes, jest.fn())).toBeNull();
        expect((await gate(yes, 'startErrand', sendArgs)).run).toBe(true);
        expect(await run('startErrand', sendArgs, yes)).toMatchObject({ success: true, sent: true });
        expect(sends.map(m => m.content)).toEqual([DRAFT]);
        expect(checkMessage).not.toHaveBeenCalled();
        expect(db.getPendingConfirmation(job.id).status).toBe('pending');
    });

    test('rule 3: a draft made in the same run as his "dale" is no draft he saw, so his word does not send it', async () => {
        // His word came first; the model then drafted and tried to send in that run.
        const yes = ownerSays('dale, mandalo', Date.now() - 1000);
        const { job, sendArgs } = await jobCardThenDraft();
        const res = await gate(yes, 'startErrand', sendArgs);
        expect(res).toMatchObject({ run: false, approvalId: job.id });
        expect(sends).toEqual([]);
    });

    test('rule 6: a message the check holds back goes nowhere and comes to him as a card with the exact text', async () => {
        checkMessage.mockResolvedValue({ ok: false, reason: 'It says more than his words.', failed: false });
        const out = await run('startErrand', { contact: CONTACT, goal: 'tell', request: 'que llego 10 minutos tarde' }, ownerSays('decile a Alice que llego 10 minutos tarde'));
        expect(sends).toEqual([]);
        expect(checkMessage).toHaveBeenCalledWith(expect.objectContaining({ draft: DRAFT }));
        const cards = db.listPendingConfirmations();
        expect(cards).toHaveLength(1);
        expect(JSON.stringify(cards[0].origin_meta?.card || {})).toContain(DRAFT);
        expect(out.sent).not.toBe(true);
    });
});
