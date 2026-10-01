/**
 * His typed ask in everyday flows (docs/errands.md, Safety): steps by voice
 * note or a short yes, drafts he saw, asks over two messages and bursts.
 * Each test guards a fault found when the message check first got his ask.
 * The real errand, approval and guardian services against a real AgentDB;
 * only the model, WhatsApp and the calendar are fakes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('axios');
const axios = require('axios');
const { AgentDB } = require('../src/db');
const { ErrandService, LIMITS, zonedMs } = require('../src/services/errands');
const { ApprovalService } = require('../src/services/approval-service');
const { GuardianService, MESSAGE_SYSTEM_INSTRUCTION } = require('../src/services/guardian-service');
const { ErrandsExecutor } = require('../src/executors/errands');

const TZ = 'America/Argentina/Cordoba';
const OWNER = '5490000000001';
const CONTACT = '5490000000002';
const CONTACT_LID = '100000000000091';
const CONTACT_JID = `${CONTACT}@s.whatsapp.net`;
const OTHER = '5490000000003';
const DEEDEE = '5490000000007';
const STATS = {
    n: 5000, questions: 600, openQuestion: 0.001, openExclamation: 0, exclamation: 0.05, endsWithPeriod: 0.001,
    startsLower: 0.2, comma: 0.1, emoji: 0.03, laugh: 0.07, multiline: 0.01, medianLength: 15, p90Length: 48, perBurst: 2.7
};
const at = (date, time) => zonedMs(date, time, TZ);
const CATCHUP = 5 * 60e3 + 1000;

/** A model request's system instruction as text. */
const systemOf = (req) => {
    const s = req?.config?.systemInstruction;
    if (typeof s === 'string') return s;
    return (s?.parts || []).map(p => p.text || '').join('') || String(s?.text || '');
};

describe('errands: his typed ask in everyday flows', () => {
    let dir, db, agent, service, approvals, clock, chat, sends, drafts, forms, calendarItems, inserted, deliver, checks, replies;

    const slotTime = (prompt) => (/Slot: [^\n]*?(\d{2}:\d{2})/.exec(prompt || '') || [])[1] || '10:00';
    const draftAnswer = (step, prompt = '') => ({
        request: { text: 'Buenas! hay lugar el jueves 8 a las 10?', date: '2026-10-08', time: '10:00' },
        accept: { text: `dale, ${slotTime(prompt)} voy`, date: '', time: '' },
        thanks: { text: 'genial, gracias', date: '', time: '' },
        propose: { text: 'y a las 11?', date: '2026-10-08', time: '11:00' },
        decline: { text: 'uh no puedo, gracias igual', date: '', time: '' },
        say: { text: 'llego 10 minutos tarde', date: '', time: '' },
        question: { text: 'venís el sábado?', date: '', time: '' },
        tell: { text: 'llego 10 minutos tarde', date: '', time: '' }
    })[step];

    const stepOf = (prompt) => {
        const m = /What to write now: (.*)/.exec(prompt);
        const line = m ? m[1] : '';
        if (/Ask CONTACT for a slot/.test(line)) return 'request';
        if (/Accept the slot/.test(line)) return 'accept';
        if (/Close with a short thanks/.test(line)) return 'thanks';
        if (/this other slot/.test(line)) return 'propose';
        if (/Say no/.test(line)) return 'decline';
        if (/owner's question/.test(line)) return 'question';
        if (/Pass the owner's message/.test(line)) return 'tell';
        return 'say';
    };

    const generateContent = jest.fn(async (req) => {
        const prompt = req.contents[0].parts[0].text;
        const usage = { promptTokenCount: 100, candidatesTokenCount: 10 };
        // The guardian's message check and card reader: fine, and "other", unless a test queues an answer.
        const system = systemOf(req);
        if (/^You check one WhatsApp message/.test(system)) return { text: JSON.stringify(checks.shift() || { ok: true, reason: 'fine' }), usageMetadata: usage };
        if (/^You read the owner's reply to one card/.test(system)) return { text: JSON.stringify(replies.shift() || { answer: 'other', reason: '' }), usageMetadata: usage };
        if (/You read the newest WhatsApp messages/.test(prompt)) {
            const form = forms.shift() || { kind: 'other', slots: [], summary: 'Small talk.' };
            return { text: JSON.stringify(form), usageMetadata: usage };
        }
        const d = drafts.shift() || draftAnswer(stepOf(prompt), prompt);
        return { text: JSON.stringify(d), usageMetadata: usage };
    });

    const contactWrites = (text, ts = clock) => {
        chat.push({ role: 'user', content: text, timestamp: ts, id: `C${chat.length}`, fromMe: false });
        return {
            source: 'whatsapp:user', content: text, timestamp: new Date(ts).toISOString(),
            metadata: { chatId: CONTACT_JID, phoneNumber: CONTACT, lid: `${CONTACT_LID}@lid` }
        };
    };

    const ownerWrites = (text, ts = clock) => chat.push({ role: 'assistant', content: text, timestamp: ts, id: `O${chat.length}`, fromMe: true });

    async function startBooking(extra = {}) {
        drafts.push(draftAnswer('request'));
        const out = await service.start({
            contact: CONTACT, goal: 'book', request: 'turno para el jueves que viene',
            date: '2026-10-08', time: '10:00', eventTitle: 'Barber - Alice', durationMinutes: 30, ...extra
        }, { originMessage: { source: 'whatsapp', metadata: { chatId: `${OWNER}@s.whatsapp.net` } } });
        expect(out.success).toBe(true);
        return db.getErrand(out.errandId);
    }

    async function contactAnswers(errand, text, form) {
        forms.push(form);
        expect(service.claim(contactWrites(text), { contactString: CONTACT, senderLid: CONTACT_LID })).toBe(true);
        await service.flush(errand.id);
        return db.getErrand(errand.id);
    }

    const pendingCards = () => db.listPendingConfirmations();
    const guardianCall = (req) => /^You (?:check one WhatsApp message|read the owner's reply to one card)/.test(systemOf(req));
    // Model calls that draft or read: the guardian's calls left out.
    const draftAndReadCalls = () => generateContent.mock.calls.filter(c => !guardianCall(c[0]));
    // The message checks the guardian got, as model requests.
    const checkRequests = () => generateContent.mock.calls.map(c => c[0]).filter(r => /^You check one WhatsApp message/.test(systemOf(r)));
    const notes = () => deliver.mock.calls.filter(c => c[0] === 'job_notification').map(c => c[3]);

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        delete process.env.ERRANDS;
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-errands-'));
        db = new AgentDB(dir);
        db.init();
        db.setAgentSetting('owner_phone', OWNER);
        db.setAgentSetting('owner_name', 'Bob');
        db.db.prepare("INSERT INTO people (id, name, phone, relationship, identifiers) VALUES ('p-alice-0000-0000-0000-000000000001', 'Alice', ?, 'barber', ?)")
            .run(CONTACT, JSON.stringify({ whatsapp: CONTACT, whatsapp_lid: CONTACT_LID }));
        clock = at('2026-09-30', '09:00');
        chat = [
            { role: 'assistant', content: 'Buenas! hay lugar el jueves a las 10hs?', timestamp: at('2026-09-04', '12:27'), id: 'H1', fromMe: true },
            { role: 'user', content: 'Sí, te anoto el jueves a las 10', timestamp: at('2026-09-04', '12:29'), id: 'H2', fromMe: false },
            { role: 'assistant', content: 'genial, gracias', timestamp: at('2026-09-04', '12:29') + 5000, id: 'H3', fromMe: true }
        ];
        sends = [];
        drafts = [];
        forms = [];
        checks = [];
        replies = [];
        calendarItems = [];
        inserted = [];
        generateContent.mockClear();
        axios.get.mockImplementation(async (url, opts) => {
            if (url.endsWith('/whatsapp/history')) return { data: chat.slice(-(opts?.params?.limit || 60)) };
            if (url.endsWith('/whatsapp/resolve')) {
                const digits = String(opts?.params?.identifier || '').replace(/@.*$/, '').replace(/\D/g, '');
                if (digits === CONTACT || digits === CONTACT_LID) {
                    return { data: { phoneJid: CONTACT_JID, lid: `${CONTACT_LID}@lid`, name: 'Alice', allJids: [CONTACT_JID, `${CONTACT_LID}@lid`] } };
                }
                return { data: { phoneJid: `${digits}@s.whatsapp.net`, lid: null, name: null, allJids: [`${digits}@s.whatsapp.net`] } };
            }
            if (url.endsWith('/whatsapp/style-stats')) return { data: STATS };
            if (url.endsWith('/whatsapp/status')) return { data: { assistant: { me: { id: DEEDEE }, allowedNumbers: [OWNER] }, user: { me: { id: OWNER }, allowedNumbers: [] } } };
            throw new Error(`unexpected GET ${url}`);
        });
        deliver = jest.fn().mockResolvedValue({ delivered: true });
        agent = {
            db,
            client: { models: { generateContent } },
            interface: {
                broadcast: jest.fn().mockResolvedValue(true),
                send: jest.fn(async (payload) => {
                    payload.sentMessageId = `W${sends.length + 1}`;
                    sends.push(payload);
                    chat.push({ role: 'assistant', content: payload.content, timestamp: clock, id: payload.sentMessageId, fromMe: true });
                    return true;
                })
            },
            delivery: {
                resolveOwnerTarget: () => ({ channel: 'whatsapp', target: `${OWNER}@s.whatsapp.net` }),
                isOwnerTarget: (channel, target) => String(target || '').replace(/@.*$/, '') === OWNER,
                deliver
            },
            mcp: {
                toolMap: new Map([['personal_calendar', { name: 'gws_personal' }], ['work_calendar', { name: 'gws_work' }]]),
                callTool: jest.fn(async (tool, args) => {
                    if (args.method === 'list') return { output: JSON.stringify({ items: calendarItems }) };
                    if (args.method === 'insert') { inserted.push({ tool, args }); return { output: JSON.stringify({ id: `EV${inserted.length}` }) }; }
                    return { error: 'unexpected' };
                })
            },
            impersonationService: { transcribeAudio: jest.fn().mockResolvedValue('te espero el jueves a las 10') },
            processMessage: jest.fn().mockResolvedValue({})
        };
        approvals = new ApprovalService(agent);
        agent.approvals = approvals;
        // The real guardian: its message check and card reader ask the scripted model above.
        expect(approvals.guardian).toBeInstanceOf(GuardianService);
        service = new ErrandService(agent, { now: () => clock, timeZone: TZ, partGapMs: 0, bufferMs: 5 });
        agent.errands = service;
        const executor = new ErrandsExecutor({ agent });
        agent._executeTool = (name, args, message, relay, usage, opts = {}) => executor.execute(name, args, { message, approved: opts.approved === true, ownerTyped: false });
    });

    afterEach(() => {
        delete process.env.VOICE_OWN_REPLY;
        service.stop();
        approvals.stop();
        delete process.env.ERRANDS;
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });


    // ---- Replays of his everyday flows ----
    const OWNER_CHAT = `${OWNER}@s.whatsapp.net`;
    const iso = (ms) => new Date(ms).toISOString();
    const REPORT = process.env.ASK_FLOW_REPORT || null;
    const confirm10 = { kind: 'confirm', slots: [{ date: '2026-10-08', time: '10:00' }], summary: 'Confirms Thursday 10.', tellOwner: false };
    // A line he typed in his chat with Deedee, stored as the agent stores it before the run.
    const typed = (id, content, ms = clock, meta = {}, extra = {}) => {
        const msg = { id, role: 'user', content, source: 'whatsapp', chatId: OWNER_CHAT, timestamp: iso(ms), metadata: { chatId: OWNER_CHAT, ...meta }, ...extra };
        db.saveMessage(msg);
        return msg;
    };
    const deedeeSays = (id, content, ms = clock) => db.saveMessage({ id, role: 'assistant', content, source: 'whatsapp', chatId: OWNER_CHAT, timestamp: iso(ms), metadata: { chatId: OWNER_CHAT } });
    // His chat run calls the tool as Agent._executeTool does: ownerTyped for his own chat.
    const run = (name, args, message) => new ErrandsExecutor({ agent }).execute(name, args, { message, approved: false, ownerTyped: true });

    const kindOf = (req) => {
        const sys = systemOf(req);
        if (/^You check one WhatsApp message/.test(sys)) return 'check';
        if (/^You read the owner's reply to one card/.test(sys)) return 'cardRead';
        if (/You read the newest WhatsApp messages/.test(req.contents[0].parts[0].text)) return 'read';
        return 'draft';
    };
    const checkInput = (req) => {
        const text = req.contents[0].parts[0].text;
        const json = JSON.parse(/<message_check>\n([\s\S]*?)\n<\/message_check>/.exec(text)[1]);
        return { step: json.step, owner_ask: json.owner_ask, summary: json.assistant_summary, his_words: json.his_words, noAskNote: /owner_ask is null/.test(text), draft: /<<<DRAFT_\w+>>>\n([\s\S]*?)\n<<<END_DRAFT/.exec(text)?.[1] ?? null };
    };
    function tally(flow) {
        const calls = generateContent.mock.calls.map(c => c[0]);
        const by = (k) => calls.filter(r => kindOf(r) === k);
        // Cards: rows that asked him (pending_confirmations), with the text he got.
        const cards = db.db.prepare('SELECT tool_name, args FROM pending_confirmations ORDER BY rowid').all().map(r => `${r.tool_name} ${r.args}`);
        const approvalMsgs = deliver.mock.calls.filter(c => c[0] === 'approval').map(c => String(c[3]?.content || '').split('\n')[0]);
        const out = {
            flow,
            sends: sends.map(s => s.content),
            cards,
            approvalMsgs,
            notes: notes().map(n => String(n.content || '').split('\n')[0]),
            modelCalls: { drafts: by('draft').length, reads: by('read').length, checks: by('check').length, cardReads: by('cardRead').length },
            checks: by('check').map(checkInput)
        };
        if (REPORT) fs.appendFileSync(REPORT, `${JSON.stringify(out)}\n`);
        return out;
    }


    describe('faults found when his words were narrowed to typed lines', () => {
        const ASK1 = 'pedile turno a Alice para el jueves a las 10';
        const REQUEST = 'Book a haircut with Alice on Thursday at 10';
        const bookArgs = { contact: CONTACT, goal: 'book', request: REQUEST, date: '2026-10-08', time: '10:00', eventTitle: 'Peluquería - Alice', durationMinutes: 30 };
        const audio = { parts: [{ inlineData: { mimeType: 'audio/ogg', data: 'AAAA' } }] };
        const say15 = { text: 'llego 15 minutos tarde', date: '', time: '' };

        test('his voice-note step "decile que llego 15 minutos tarde" goes out: the code check must not drop the words of his step', async () => {
            const out = await run('startErrand', bookArgs, typed('t1', ASK1));
            expect(out.success).toBe(true);
            clock += 10 * 60e3;
            drafts.push(say15, say15);
            const res = await run('answerErrand', { id: out.errandId, action: 'say', text: 'llego 15 minutos tarde' }, typed('v1', '[Voice Message]', clock, {}, audio));
            const t = tally('voice-note step with a number');
            expect(res.error || '').toBe('');
            expect(res.success).toBe(true);
            expect(t.sends).toContain('llego 15 minutos tarde');
        });

        test('"decile que llego 15 minutos tarde, no lo mandes todavía", then "dale, mandalo": the step goes out', async () => {
            const out = await run('startErrand', bookArgs, typed('t1', ASK1));
            clock += 10 * 60e3;
            typed('t2', 'decile a Alice que llego 15 minutos tarde, no lo mandes todavía');
            deedeeSays('d2', 'Le mandaría: "llego 15 minutos tarde". ¿Lo mando?', clock + 5000);
            clock += 30e3;
            drafts.push(say15, say15);
            const res = await run('answerErrand', { id: out.errandId, action: 'say', text: 'llego 15 minutos tarde' }, typed('t3', 'dale, mandalo'));
            const t = tally('step confirmed by dale mandalo');
            expect(res.error || '').toBe('');
            expect(res.success).toBe(true);
            expect(t.sends).toContain('llego 15 minutos tarde');
        });

        test('his voice-note step behind a gate card, then his yes on the web: the step goes out', async () => {
            const out = await run('startErrand', bookArgs, typed('t1', ASK1));
            clock += 10 * 60e3;
            const step = typed('v2', '[Voice Message]', clock, {}, audio);
            const args = { id: out.errandId, action: 'say', text: 'llego 15 minutos tarde' };
            const gate = await approvals.review({ message: step, toolName: 'answerErrand', args, historyUntrusted: true, foreignText: false });
            expect(gate.status).toBe('paused');
            const executor = new ErrandsExecutor({ agent });
            agent._executeTool = (name, a, message, relay, usage, opts = {}) => executor.execute(name, a, { message, approved: opts.approved === true, ownerTyped: true });
            drafts.push(say15, say15);
            clock += 30e3;
            const card = pendingCards().find(c => c.tool_name === 'answerErrand');
            await approvals.decide(card.id, 'approved', { via: 'web' });
            const t = tally('voice step behind a gate card');
            expect(t.sends).toContain('llego 15 minutos tarde');
        });

        const tellArgs = { contact: CONTACT, goal: 'tell', request: 'Tell Alice he will transfer the 20 mil on Friday' };
        const LINE20 = 'decile a Alice que el viernes le transfiero los 20 mil, no lo mandes todavía';

        test('a tell draft with money he saw 31 minutes ago: his "dale, mandalo" sends it', async () => {
            drafts.push({ text: 'el viernes te transfiero los 20 mil', date: '', time: '' });
            const draft = await run('startErrand', { ...tellArgs, send: false }, typed('t1', LINE20));
            expect(draft).toMatchObject({ success: true, sent: false });
            clock += 60e3;
            deedeeSays('d1', `Le mandaría: "${draft.preview}". ¿Lo mando?`);
            clock += 31 * 60e3;
            const out = await run('startErrand', { ...tellArgs, send: true, text: draft.draft }, typed('t2', 'dale, mandalo'));
            tally('money draft after 31 minutes');
            expect(out.error || '').toBe('');
            expect(out).toMatchObject({ success: true, sent: true });
        });

        test('a tell draft with money, a restart, then "dale, mandalo" (Deedee showed it with no question mark): it sends', async () => {
            drafts.push({ text: 'el viernes te transfiero los 20 mil', date: '', time: '' });
            const draft = await run('startErrand', { ...tellArgs, send: false }, typed('t1', LINE20));
            expect(draft).toMatchObject({ success: true, sent: false });
            clock += 60e3;
            deedeeSays('d1', `Le mandaría esto: "${draft.preview}". Avisame y lo mando.`);
            service.stop();
            service = new ErrandService(agent, { now: () => clock, timeZone: TZ, partGapMs: 0, bufferMs: 5 });
            agent.errands = service;
            clock += 3 * 60e3;
            const out = await run('startErrand', { ...tellArgs, send: true, text: draft.draft }, typed('t2', 'dale, mandalo'));
            tally('money draft after a restart');
            expect(out.error || '').toBe('');
            expect(out).toMatchObject({ success: true, sent: true });
        });

        test('a draft for Carol he never sent (send=false), Deedee\'s "¿Lo mando?", then his ask for Alice: Carol\'s line stays out of Alice\'s ask', async () => {
            const t0 = clock - 3 * 60e3;
            typed('c1', 'decile a Carol que el viernes le paso los 20 mil, no lo mandes todavía', t0);
            db.saveMessage({
                id: 'm1', role: 'model', source: 'whatsapp', chatId: OWNER_CHAT, timestamp: iso(t0 + 2000), metadata: { chatId: OWNER_CHAT },
                parts: [{ functionCall: { name: 'startErrand', args: { contact: OTHER, goal: 'tell', request: 'Tell Carol he pays the 20 mil on Friday', send: false } } }]
            });
            deedeeSays('d1', 'Le mandaría a Carol: "el viernes te paso los 20 mil". ¿Lo mando?', t0 + 5000);
            const out = await run('startErrand', bookArgs, typed('t1', ASK1));
            expect(out.success).toBe(true);
            const t = tally('Carol draft line before Alice ask');
            expect(db.getErrand(out.errandId).ask.original).toEqual([ASK1]);
            expect(t.checks[0].owner_ask.original).toEqual([ASK1]);
        });

        test('his ask in two messages ("preguntale a Alice si abre el sábado", "¿Le pregunto también hasta qué hora?", "sí, y a qué hora cierra") behind a gate card: the check still knows the sábado line', async () => {
            typed('t1', 'preguntale a Alice si abre el sábado', clock - 60e3);
            deedeeSays('d1', '¿Le pregunto también hasta qué hora?', clock - 50e3);
            const step = typed('t2', 'sí, y a qué hora cierra');
            const args = { contact: CONTACT, goal: 'ask', request: 'Ask Alice whether she opens on Saturday and until what time' };
            // A tainted row in his chat (an errand note) gates his start.
            const gate = await approvals.review({ message: step, toolName: 'startErrand', args, historyUntrusted: true, foreignText: false });
            expect(gate.status).toBe('paused');
            const executor = new ErrandsExecutor({ agent });
            agent._executeTool = (name, a, message, relay, usage, opts = {}) => executor.execute(name, a, { message, approved: opts.approved === true, ownerTyped: true });
            drafts.push({ text: 'abrís el sábado? hasta qué hora?', date: '', time: '' });
            clock += 30e3;
            const card = pendingCards().find(c => c.tool_name === 'startErrand');
            await approvals.decide(card.id, 'approved', { via: 'web' });
            const t = tally('two-message ask behind a gate card');
            expect(t.checks).toHaveLength(1);
            const ask = t.checks[0].owner_ask;
            // Either his whole ask, or none (the fallback reads the summary): never only the second line.
            expect(ask === null || ask.original.some(l => /sábado/.test(l))).toBe(true);
        });

        test('"sacale turno a Alice, cuando tenga" with the draft the brief asks for (his usual time): the check gets something that lets that time pass', async () => {
            // voice.js buildPrompt, noTime: "Ask for the time he usually books with CONTACT, as the chat shows it".
            drafts.push({ text: 'Buenas! hay lugar a las 10hs?', date: '', time: '10:00' });
            const out = await run('startErrand', { contact: CONTACT, goal: 'book', request: 'Book a haircut with Alice, any day she has', durationMinutes: 30 }, typed('t1', 'sacale turno a Alice para cortarme el pelo, cuando tenga'));
            const t = tally('no-day booking, usual time');
            expect(t.checks).toHaveLength(1);
            const c = t.checks[0];
            const req = checkRequests()[0];
            const json = JSON.parse(/<message_check>\n([\s\S]*?)\n<\/message_check>/.exec(req.contents[0].parts[0].text)[1]);
            // No slot, no window, no time in his ask, and the request rule says a time only when owner_ask names one.
            const allows = (json.slot && json.slot.time) || /usual|suele|habitual/i.test(String(json.step_allows) + systemOf(req));
            expect(c.owner_ask.original).toEqual(['sacale turno a Alice para cortarme el pelo, cuando tenga']);
            expect(!!allows).toBe(true);
        });

        test('the instruction says an empty "now" means the errand took the step by itself, but his own voice-note say reaches it with "now" empty', async () => {
            const out = await run('startErrand', bookArgs, typed('t1', ASK1));
            clock += 10 * 60e3;
            drafts.push({ text: 'llego un toque tarde', date: '', time: '' });
            const res = await run('answerErrand', { id: out.errandId, action: 'say', text: 'llego un toque tarde' }, typed('v1', '[Voice Message]', clock, {}, audio));
            expect(res.success).toBe(true);
            const t = tally('voice-note say, now empty');
            expect(t.checks[1]).toMatchObject({ step: 'say', owner_ask: { original: [ASK1], now: [] } });
            expect(MESSAGE_SYSTEM_INSTRUCTION).not.toMatch(/it is empty when the errand takes the step by itself/);
        });

        test('his tell in a burst of two lines, no reply between ("decile a Alice que el viernes le transfiero", "los 20 mil"): the check still knows the viernes line', async () => {
            typed('t1', 'decile a Alice que el viernes le transfiero', clock - 4000);
            drafts.push({ text: 'el viernes te transfiero los 20 mil', date: '', time: '' });
            const out = await run('startErrand', { contact: CONTACT, goal: 'tell', request: 'Tell Alice he will transfer the 20 mil on Friday' }, typed('t2', 'los 20 mil'));
            expect(out.success).toBe(true);
            const t = tally('burst tell');
            const ask = t.checks[0].owner_ask;
            expect(ask === null || ask.original.some(l => /viernes/.test(l))).toBe(true);
        });
    });
});
