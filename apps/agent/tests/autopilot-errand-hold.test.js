/**
 * While an errand holds a contact's chat, only the errand writes to her
 * (services/errands.js). Autopilot in full mode used to send a reply it
 * buffered from just before the errand started. Real AgentDB in a temp
 * folder and the real ImpersonationService; the errand check is a small
 * stand-in for ErrandService.holds(idList), and the real ErrandService in
 * its own block. Placeholders only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ImpersonationService } = require('../src/services/impersonation');
const { AgentDB } = require('../src/db');

const CONTACT = '5490000000002';
const CONTACT_LID = '100000000000091';
const CHAT = `${CONTACT}@s.whatsapp.net`;
const LID_CHAT = `${CONTACT_LID}@lid`;
const OWNER_CHAT = '5490000000001@s.whatsapp.net';

describe('Autopilot keeps out of a chat an errand holds', () => {
    let dir, db, agent, service, deliver, held, sends;

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-autopilot-errand-'));
        db = new AgentDB(dir);
        db.init();
        db.db.prepare("INSERT INTO people (id, name, phone, identifiers, autopilot_status) VALUES ('p1', 'Alice', ?, ?, 'full')")
            .run(CONTACT, JSON.stringify({ whatsapp: CONTACT, whatsapp_lid: CONTACT_LID }));
        deliver = jest.fn().mockResolvedValue({ delivered: true });
        held = false;
        sends = [];
        agent = {
            db,
            interface: { send: jest.fn(async (p) => { sends.push(p); return true; }), broadcast: jest.fn() },
            delivery: { resolveOwnerTarget: () => ({ channel: 'whatsapp', target: OWNER_CHAT }), deliver },
            client: { models: { generateContent: jest.fn() } },
            errands: { holds: jest.fn(() => held) }
        };
        service = new ImpersonationService(agent);
        service.generateDraft = jest.fn().mockResolvedValue({ text: 'jaja todo bien, vos?', cost: 0 });
    });

    afterEach(() => {
        jest.useRealTimers();
        db.close();
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const fromAlice = (text, chatId = CHAT) => ({
        source: 'whatsapp:user', content: text,
        metadata: { chatId, phoneNumber: CONTACT, lid: LID_CHAT }
    });
    const drafts = () => db.db.prepare('SELECT status, sent_count FROM autopilot_drafts ORDER BY id').all();

    test('a reply buffered before an errand started is neither drafted nor sent while the errand holds her chat', async () => {
        jest.useFakeTimers();
        await service.handleMessage(CHAT, fromAlice('holaa como andas'), CONTACT);
        expect(jest.getTimerCount()).toBe(1);
        // He starts an errand with Alice; Autopilot's timer then fires.
        held = true;
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(service.generateDraft).not.toHaveBeenCalled();
        expect(sends).toEqual([]);
        expect(drafts()).toEqual([]);
        // The buffered reply and its timer are gone.
        expect(service.messageBuffers.has(CHAT)).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('an errand that starts while Autopilot drafts stops the reply: nothing goes out and no draft waits', async () => {
        service.generateDraft.mockImplementation(async () => { held = true; return { text: 'dale, 10:30 me viene perfecto', cost: 0 }; });
        await service.handleMessage(CHAT, fromAlice('holaa como andas'), CONTACT);
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(service.generateDraft).toHaveBeenCalledTimes(1);
        expect(sends).toEqual([]);
        expect(drafts()).toEqual([]);
    });

    test('an errand that starts between two parts of a reply stops the rest', async () => {
        service.generateDraft.mockResolvedValue({ text: 'jaja todo bien [SPLIT] vos?', cost: 0 });
        agent.interface.send.mockImplementation(async (p) => { sends.push(p); held = true; return true; });
        await service.handleMessage(CHAT, fromAlice('holaa como andas'), CONTACT);
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(sends.map(s => s.content)).toEqual(['jaja todo bien']);
        expect(drafts()).toEqual([{ status: 'partially_sent', sent_count: 1 }]);
        // The note goes to the owner, never to Alice.
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver.mock.calls[0][2]).toBe(OWNER_CHAT);
        expect(deliver.mock.calls[0][3].content).toMatch(/an errand now holds this chat/);
    });

    test('a chat shown by her WhatsApp ID is still checked by her number: Autopilot passes every id it has', async () => {
        held = true;
        // The interfaces did not know her number: only her People row holds it.
        const msg = { source: 'whatsapp:user', content: 'holaa', metadata: { chatId: LID_CHAT, lid: LID_CHAT } };
        await service.handleMessage(LID_CHAT, msg, CONTACT_LID);
        await service.processBufferedMessage(LID_CHAT, CONTACT_LID);
        const ids = agent.errands.holds.mock.calls[0][0];
        expect(ids).toEqual(expect.arrayContaining([LID_CHAT, CONTACT_LID, CONTACT]));
        expect(sends).toEqual([]);
    });

    test('a failed errand check keeps Autopilot out of the chat', async () => {
        agent.errands.holds.mockImplementation(() => { throw new Error('db locked'); });
        await service.handleMessage(CHAT, fromAlice('holaa'), CONTACT);
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(sends).toEqual([]);
        expect(drafts()).toEqual([]);
    });

    test('with no errand holding her chat, or no errand service at all, Autopilot replies as before', async () => {
        await service.handleMessage(CHAT, fromAlice('holaa'), CONTACT);
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(sends.map(s => s.content)).toEqual(['jaja todo bien, vos?']);
        delete agent.errands;
        await service.handleMessage(CHAT, fromAlice('y?'), CONTACT);
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(sends).toHaveLength(2);
        expect(drafts().map(d => d.status)).toEqual(['approved', 'approved']);
    });
});

describe('Autopilot against the real ErrandService', () => {
    const { ErrandService } = require('../src/services/errands');
    let dir, db, agent, sends;

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-autopilot-real-errands-'));
        db = new AgentDB(dir);
        db.init();
        db.db.prepare("INSERT INTO people (id, name, phone, identifiers, autopilot_status) VALUES ('p1', 'Alice', ?, ?, 'full')")
            .run(CONTACT, JSON.stringify({ whatsapp: CONTACT, whatsapp_lid: CONTACT_LID }));
        sends = [];
        agent = {
            db,
            interface: { send: jest.fn(async (p) => { sends.push(p); return true; }), broadcast: jest.fn() },
            delivery: { resolveOwnerTarget: () => ({ channel: 'whatsapp', target: OWNER_CHAT }), deliver: jest.fn().mockResolvedValue({ delivered: true }) },
            client: { models: { generateContent: jest.fn() } }
        };
        agent.errands = new ErrandService(agent);
    });

    afterEach(() => {
        agent.errands.stop();
        db.close();
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const openErrand = () => db.createErrand({
        goal: 'book', state: 'waiting_contact', contactJid: CHAT, contactIds: [CONTACT, CONTACT_LID], contactName: 'Alice',
        personId: 'p1', request: 'turno para el jueves', expiresAt: new Date(Date.now() + 86400e3).toISOString()
    });

    test('holds() answers at once with true or false: a promise or a missing method would let Autopilot read it wrong', () => {
        expect(typeof agent.errands.holds).toBe('function');
        expect(agent.errands.holds([CHAT, CONTACT])).toBe(false);
        openErrand();
        expect(agent.errands.holds([CHAT, CONTACT])).toBe(true);
        expect(agent.errands.holds([LID_CHAT])).toBe(true);
        expect(agent.errands.holds(['5490000000003@s.whatsapp.net'])).toBe(false);
    });

    const autopilotReplies = async () => {
        const autopilot = new ImpersonationService(agent);
        jest.spyOn(autopilot, 'generateDraft').mockResolvedValue({ text: 'dale, 10:30 me viene perfecto', cost: 0 });
        await autopilot.handleMessage(CHAT, { source: 'whatsapp:user', content: 'holaa', metadata: { chatId: CHAT, phoneNumber: CONTACT } }, CONTACT);
        const buf = autopilot.messageBuffers.get(CHAT);
        if (buf?.timer) clearTimeout(buf.timer);
        await autopilot.processBufferedMessage(CHAT, CONTACT);
    };

    test('an open errand with Alice keeps Autopilot (full) from writing to her', async () => {
        openErrand();
        await autopilotReplies();
        expect(sends).toEqual([]);
        expect(db.db.prepare('SELECT COUNT(*) AS n FROM autopilot_drafts').get().n).toBe(0);
    });

    test('with no errand open, Autopilot (full) answers her as before', async () => {
        await autopilotReplies();
        expect(sends.map(s => s.content)).toEqual(['dale, 10:30 me viene perfecto']);
    });
});

describe('the agent drops Autopilot\'s reply when an errand claims her message', () => {
    const { Agent } = require('../src/agent');
    let dir, db, agent;

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(console, 'time').mockImplementation(() => { });
        jest.spyOn(console, 'timeEnd').mockImplementation(() => { });
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-autopilot-claim-'));
        db = new AgentDB(dir);
        db.init();
        db.db.prepare("INSERT INTO people (id, name, phone, autopilot_status) VALUES ('p1', 'Alice', ?, 'full')").run(CONTACT);
        agent = new Agent({ googleApiKey: 'test-key', db, interface: { send: jest.fn().mockResolvedValue(true), broadcast: jest.fn().mockResolvedValue(true), on: jest.fn() } });
        agent.client = { models: { generateContent: jest.fn() } };
    });

    afterEach(() => {
        jest.useRealTimers();
        db.close();
        jest.restoreAllMocks();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('her message an errand claims drops the reply Autopilot buffered for her chat, and its timer', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        const autopilot = agent.impersonationService;
        const draft = jest.spyOn(autopilot, 'generateDraft');
        // Alice wrote just before he asked for the errand: Autopilot buffers it.
        await autopilot.handleMessage(CHAT, { source: 'whatsapp:user', content: 'holaa', metadata: { chatId: CHAT, phoneNumber: CONTACT } }, CONTACT);
        expect(autopilot.messageBuffers.has(CHAT)).toBe(true);
        // Her next message belongs to the open errand.
        jest.spyOn(agent.errands, 'claim').mockReturnValue(true);
        await agent.processMessage({ role: 'user', source: 'whatsapp:user', content: 'tengo 10:30', metadata: { chatId: CHAT, phoneNumber: CONTACT } }, jest.fn());
        expect(agent.errands.claim).toHaveBeenCalledTimes(1);
        expect(autopilot.messageBuffers.has(CHAT)).toBe(false);
        await jest.advanceTimersByTimeAsync(30000);
        expect(draft).not.toHaveBeenCalled();
        expect(agent.interface.send).not.toHaveBeenCalled();
    });
});
