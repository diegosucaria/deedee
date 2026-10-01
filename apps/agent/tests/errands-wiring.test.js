/**
 * Errands touch shared places: the prompt, the voice tool list, the gate's
 * rules, the guardian history and the send path. Each check guards a fault
 * the first review found.
 */
const express = require('express');
const request = require('supertest');

jest.mock('axios');
const axios = require('axios');
const { getSystemInstruction, getTurnContext, ERRAND_RULES } = require('../src/prompts/system');
const { ConfirmationManager } = require('../src/confirmation-manager');
const { OUTWARD_RULES } = require('../src/services/approval-service');
const { SOURCE_KINDS } = require('../src/routes/guardian');
const { HttpInterface } = require('../src/http-interface');
const { createToolRouter } = require('../src/routes/tools');

describe('errands in shared places', () => {
    test('the errand rules ride only in his own chat\'s turn context, never in the shared prompt', () => {
        const prompt = getSystemInstruction('T', 'G', 'F', { dynamicInTurn: true });
        expect(prompt).not.toContain('startErrand');
        expect(getTurnContext({ dateString: 'T' })).not.toContain('ERRANDS');
        const own = getTurnContext({ dateString: 'T', errandRules: true, openErrands: ['#3 book with Alice: waiting for them'] });
        expect(own).toContain(ERRAND_RULES);
        expect(own).toContain('OPEN ERRANDS');
        expect(own).toContain('#3 book with Alice: waiting for them');
    });

    test('a voice call never gets the errand tools: they only work in his typed chat', async () => {
        const app = express();
        app.use(createToolRouter({ mcp: { getTools: async () => [] } }));
        const res = await request(app).get('/internal/tools');
        expect(res.statusCode).toBe(200);
        const names = res.body.tools.map(t => t.name);
        expect(names).toContain('sendMessage');
        for (const name of ['startErrand', 'answerErrand', 'listErrands']) expect(names).not.toContain(name);
    });

    test('starting or answering an errand is an outward action; cancelling one is not', () => {
        const rules = new ConfirmationManager({});
        expect(rules.check('startErrand', { contact: '5490000000002' })).toMatchObject({ requiresConfirmation: true, rule: 'errand-send' });
        expect(rules.check('answerErrand', { id: 1, action: 'say', text: 'hola' })).toMatchObject({ rule: 'errand-send' });
        expect(rules.check('answerErrand', { id: 1, action: 'cancel' }).requiresConfirmation).toBe(false);
        expect(OUTWARD_RULES.has('errand-send')).toBe(true);
    });

    test('every tool the errand rules name exists', () => {
        const { toolDefinitions } = require('../src/tools-definition');
        const names = new Set(toolDefinitions.flatMap(d => d.functionDeclarations || []).map(t => t.name));
        const named = [...ERRAND_RULES.matchAll(/'([a-z]+[A-Z][a-zA-Z]+)'/g)].map(m => m[1]);
        expect(named.length).toBeGreaterThan(3);
        for (const name of named) expect(names.has(name)).toBe(true);
    });

    test('the guardian history knows errand runs', () => {
        expect(SOURCE_KINDS).toContain('errand');
    });

    test('a frozen payload still reports a message that went out', async () => {
        axios.post.mockResolvedValue({ data: { success: true, messageId: 'W1' } });
        jest.spyOn(console, 'log').mockImplementation(() => { });
        const out = await new HttpInterface('http://interfaces:5000', 't').send(Object.freeze({ source: 'whatsapp', content: 'hola', metadata: { chatId: '15550100@s.whatsapp.net' } }));
        expect(out).toBe(true);
        console.log.mockRestore();
    });

    test('a job run held in his chat is never his typing, so it gets no errand rules or tools', async () => {
        const { Agent } = require('../src/agent');
        const self = { approvals: { _isOwnerChat: async () => true } };
        const typed = { source: 'whatsapp', content: 'pedile turno', metadata: { chatId: '100000000000099@lid' } };
        expect(await Agent.prototype._ownerTyped.call(self, typed)).toBe(true);
        expect(await Agent.prototype._ownerTyped.call(self, { ...typed, metadata: { ...typed.metadata, jobName: 'x' } })).toBe(false);
        expect(await Agent.prototype._ownerTyped.call(self, { source: 'web', content: 'x', metadata: { chatId: 'w', jobName: 'x' } })).toBe(false);
    });

    test('an errand\'s note keeps its errand id in his chat, so a bare yes after it is not for an older card', async () => {
        const { Agent } = require('../src/agent');
        const saved = [];
        const self = {
            _ownerPreferredJid: '100000000000099@lid',
            _normalizeWaChatId: Agent.prototype._normalizeWaChatId,
            _getOwnerWaIds: async () => new Set(['5490000000001@s.whatsapp.net', '100000000000099@lid']),
            db: { saveMessageIfNew: (m) => saved.push(m) }
        };
        await Agent.prototype._mirrorToOwnerChat.call(self, { id: 'n1', source: 'whatsapp:assistant', type: 'text', content: 'Alice preguntó algo', metadata: { chatId: '5490000000001@s.whatsapp.net', errandId: 4 } });
        expect(saved[0].metadata).toMatchObject({ type: 'text', errandId: 4 });
    });

    test('a card his bare yes did not reach is named in the turn context, with how to answer it', () => {
        const ctx = getTurnContext({ dateString: 'T', waitingCard: { id: 'abc123', toolName: 'sendEmail' } });
        expect(ctx).toContain('A CARD WAITS IN THIS CHAT: abc123 (sendEmail)');
        expect(ctx).toContain('/confirm abc123');
        expect(getTurnContext({ dateString: 'T' })).not.toContain('A CARD WAITS');
    });
});

describe('his draft, then "dale, mandalo", while a job card waits in his chat', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { AgentDB } = require('../src/db');
    const { ErrandService } = require('../src/services/errands');
    const { ApprovalService } = require('../src/services/approval-service');
    const { ErrandsExecutor } = require('../src/executors/errands');

    const OWNER = '5490000000001';
    const OWNER_CHAT = `${OWNER}@s.whatsapp.net`;
    const OWNER_LID = '100000000000099@lid';
    const CONTACT = '5490000000002';
    const CONTACT_LID = '100000000000091';
    const CONTACT_JID = `${CONTACT}@s.whatsapp.net`;
    const STATS = {
        n: 5000, questions: 600, openQuestion: 0.001, openExclamation: 0, exclamation: 0.05, endsWithPeriod: 0.001,
        startsLower: 0.2, comma: 0.1, emoji: 0.03, laugh: 0.07, multiline: 0.01, medianLength: 15, p90Length: 48, perBurst: 2.7
    };
    let dir, db, agent, approvals, service, executor, chat, sends, wall;

    // A line in his chat with Deedee, a second after the one before.
    const said = (role, content) => {
        wall += 1000;
        const msg = { id: `m${wall}`, role, content, source: 'whatsapp', chatId: OWNER_LID, timestamp: new Date(wall).toISOString(), metadata: { chatId: OWNER_LID } };
        if (role === 'assistant') db.saveMessage(msg);
        return msg;
    };
    const run = async (name, args, message) => executor.execute(name, args, { message, approved: false, ownerTyped: await agent._ownerTyped(message) });

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        delete process.env.ERRANDS;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-errands-draft-'));
        db = new AgentDB(dir);
        db.init();
        db.setAgentSetting('owner_phone', OWNER);
        db.db.prepare("INSERT INTO people (id, name, phone, relationship, identifiers) VALUES ('p-alice-0000-0000-0000-000000000001', 'Alice', ?, 'barber', ?)")
            .run(CONTACT, JSON.stringify({ whatsapp: CONTACT, whatsapp_lid: CONTACT_LID }));
        chat = [{ role: 'assistant', content: 'Buenas! hay lugar el jueves a las 10hs?', timestamp: Date.now() - 20 * 86400e3, id: 'H1', fromMe: true }];
        sends = [];
        wall = Date.now();
        axios.get.mockImplementation(async (url, opts) => {
            if (url.endsWith('/whatsapp/history')) return { data: chat.slice(-(opts?.params?.limit || 60)) };
            if (url.endsWith('/whatsapp/resolve')) {
                return { data: { phoneJid: CONTACT_JID, lid: `${CONTACT_LID}@lid`, name: 'Alice', allJids: [CONTACT_JID, `${CONTACT_LID}@lid`] } };
            }
            if (url.endsWith('/whatsapp/style-stats')) return { data: STATS };
            if (url.endsWith('/whatsapp/status')) return { data: { assistant: { me: { id: '5490000000007' } }, user: { me: { id: OWNER } } } };
            throw new Error(`unexpected GET ${url}`);
        });
        // The guardian's message check and card reader get their own answers; every other call drafts.
        const generateContent = jest.fn(async (req) => {
            const usage = { promptTokenCount: 1, candidatesTokenCount: 1 };
            const sys = typeof req?.config?.systemInstruction === 'string' ? req.config.systemInstruction : (req?.config?.systemInstruction?.parts || []).map(p => p.text || '').join('');
            if (/^You check one WhatsApp message/.test(sys)) return { text: JSON.stringify({ ok: true, reason: 'fine' }), usageMetadata: usage };
            if (/^You read the owner's reply to one card/.test(sys)) return { text: JSON.stringify({ answer: 'other', reason: '' }), usageMetadata: usage };
            return { text: JSON.stringify({ text: 'llego 10 minutos tarde', date: '', time: '' }), usageMetadata: usage };
        });
        agent = {
            db,
            client: { models: { generateContent } },
            notifications: { create: jest.fn() },
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
            processMessage: jest.fn().mockResolvedValue({}),
            _getOwnerWaIds: async () => new Set([OWNER_CHAT, OWNER_LID]),
            _ownerTyped: async (m) => m?.source === 'whatsapp' && !m?.metadata?.jobName && [OWNER_CHAT, OWNER_LID].includes(m?.metadata?.chatId)
        };
        approvals = new ApprovalService(agent);
        agent.approvals = approvals;
        // GuardianService.checkMessage comes in a change of its own: until it
        // lands, a stand-in with its contract asks the same fake model.
        if (typeof approvals.guardian.checkMessage !== 'function') {
            approvals.guardian.checkMessage = async (p) => {
                const res = await agent.client.models.generateContent({ contents: [{ role: 'user', parts: [{ text: JSON.stringify(p) }] }], config: { systemInstruction: 'You check one WhatsApp message.' } });
                const a = JSON.parse(res.text);
                return { ok: a.ok === true, reason: String(a.reason || ''), failed: false };
            };
        }
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

    test('he asks for a draft ("no lo mandes todavía"), sees it and says "dale, mandalo": the draft goes out, and the job card still waits', async () => {
        const job = await approvals.request({ message: { source: 'scheduler', metadata: { jobName: 'facturas', chatId: 'scheduled_facturas' } }, toolName: 'sendEmail', args: { to: 'user@example.com', subject: 'x' }, reason: 'r' });
        const ask = said('user', 'decile a Alice que llego 10 minutos tarde, no lo mandes todavía');
        const args = { contact: CONTACT, goal: 'tell', request: 'que llego 10 minutos tarde', send: false };
        expect((await approvals.review({ message: ask, toolName: 'startErrand', args, historyUntrusted: false, foreignText: false })).run).toBe(true);
        const madeAt = Date.now();
        const draft = await run('startErrand', args, ask);
        expect(draft).toMatchObject({ success: true, sent: false, draft: 'llego 10 minutos tarde' });
        expect(sends).toHaveLength(0);
        said('assistant', `Le mandaría a Alice: "${draft.preview}". ¿Lo mando?`);
        // His "dale, mandalo" is about the draft, never the job's card.
        const yes = said('user', 'dale, mandalo');
        expect(await approvals.intercept(yes, jest.fn())).toBeNull();
        const sendArgs = { ...args, send: true, text: draft.draft };
        // Shown before his "dale, mandalo", not after it.
        const chatIds = [yes.metadata.chatId];
        expect(service.isShownDraft(sendArgs, { before: Date.parse(yes.timestamp), chatIds })).toBe(true);
        expect(service.isShownDraft(sendArgs, { before: madeAt - 1, chatIds })).toBe(false);
        const review = await approvals.review({ message: yes, toolName: 'startErrand', args: sendArgs, historyUntrusted: false, foreignText: false });
        expect(review.run).toBe(true);
        const out = await run('startErrand', sendArgs, yes);
        expect(out).toMatchObject({ success: true, sent: true });
        expect(sends.map(s => s.content)).toEqual(['llego 10 minutos tarde']);
        expect(sends[0].metadata).toEqual({ chatId: CONTACT_JID, session: 'user', strictSession: true });
        expect(db.getPendingConfirmation(job.id).status).toBe('pending');
        // He saw these words: no message check, and the draft is used up.
        const checked = agent.client.models.generateContent.mock.calls.filter(c => /^You check one WhatsApp message/.test(String(c[0]?.config?.systemInstruction || '')));
        expect(checked).toHaveLength(0);
        expect(service.isShownDraft(sendArgs)).toBe(false);
    });

    test('through the tools, the message check gets his typed words: his ask for the start, his next line for a step', async () => {
        const spy = jest.spyOn(approvals.guardian, 'checkMessage');
        // The agent stores his line before the run; Deedee's own line between his two does not count.
        const typed = (content) => { const m = said('user', content); db.saveMessage(m); return m; };
        typed('preguntale a Alice si tiene el libro');
        said('assistant', '¿Algo más?');
        const ask = typed('y si me lo guarda hasta el lunes');
        const request = 'Ask Alice whether she has the book and can keep it';
        const out = await run('startErrand', { contact: CONTACT, goal: 'ask', request, text: 'tenés el libro? me lo guardás?' }, ask);
        expect(out).toMatchObject({ success: true, sent: true });
        expect(spy.mock.calls[0][0]).toMatchObject({
            step: 'question', summary: request,
            ask: { original: ['preguntale a Alice si tiene el libro', 'y si me lo guarda hasta el lunes'], now: [] }
        });
        const step = typed('decile que llego 10 minutos tarde');
        const res = await run('answerErrand', { id: out.errandId, action: 'say', text: 'llego 10 minutos tarde' }, step);
        expect(res.success).toBe(true);
        expect(spy.mock.calls[1][0]).toMatchObject({
            step: 'say', hisWords: 'llego 10 minutos tarde',
            ask: { original: ['preguntale a Alice si tiene el libro', 'y si me lo guarda hasta el lunes'], now: ['decile que llego 10 minutos tarde'] }
        });
        expect(sends.map(s => s.content)).toEqual(['tenés el libro? me lo guardás?', 'llego 10 minutos tarde']);
    });
});
