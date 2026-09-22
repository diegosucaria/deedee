/**
 * Autopilot in autonomous mode sends a reply as the owner. HttpInterface.send
 * reports a refused send as false, not a throw, and the draft used to be
 * marked approved either way: the owner saw "sent", the contact got nothing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ImpersonationService } = require('../src/services/impersonation');
const { AgentDB } = require('../src/db');

const CONTACT = '10000000001';
const CHAT = `${CONTACT}@s.whatsapp.net`;

describe('autonomous Autopilot and a refused send', () => {
    let dir, db, agent, service, deliver;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-autopilot-'));
        db = new AgentDB(dir);
        db.init();
        db.db.prepare("INSERT INTO people (id, name, phone, autopilot_status) VALUES (?, ?, ?, 'full')").run('p1', 'Alice', CONTACT);
        deliver = jest.fn().mockResolvedValue({ delivered: true });
        agent = {
            db,
            interface: { send: jest.fn(), broadcast: jest.fn() },
            delivery: { resolveOwnerTarget: () => ({ channel: 'whatsapp', target: '10000000000@s.whatsapp.net' }), deliver },
            client: { models: { generateContent: jest.fn() } },
        };
        service = new ImpersonationService(agent);
        service.generateDraft = jest.fn().mockResolvedValue({ text: 'Hola [SPLIT] Nos vemos mañana', cost: 0 });
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const buffered = () => service.messageBuffers.set(CHAT, { content: ['hola, mañana?'], metadata: {}, source: 'whatsapp' });
    const draft = () => db.db.prepare('SELECT status FROM autopilot_drafts WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(CHAT);

    test('a reply that went out is marked approved, and the owner is not bothered', async () => {
        agent.interface.send.mockResolvedValue(true);
        buffered();
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(agent.interface.send).toHaveBeenCalledTimes(2);
        expect(draft().status).toBe('approved');
        expect(deliver).not.toHaveBeenCalled();
    });

    test('a refused reply stays a pending draft, and the owner hears that nothing went out', async () => {
        agent.interface.send.mockResolvedValue(false);
        buffered();
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(agent.interface.send).toHaveBeenCalledTimes(1);
        expect(draft().status).toBe('pending');
        expect(deliver).toHaveBeenCalledTimes(1);
        const [kind, channel, target, payload, opts] = deliver.mock.calls[0];
        expect(kind).toBe('job_notification');
        expect(channel).toBe('whatsapp:assistant');
        expect(target).toBe('10000000000@s.whatsapp.net');
        expect(payload.content).toMatch(/Nothing went out/);
        expect(payload.content).toMatch(/Autopilot → Drafts/);
        expect(opts).toMatchObject({ origin: 'autopilot', dedupe: false });
    });

    test('a reply that went out in part waits as partially sent, so the owner can finish it from the web', async () => {
        agent.interface.send.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        buffered();
        await service.processBufferedMessage(CHAT, CONTACT);
        const row = db.db.prepare('SELECT status, sent_count FROM autopilot_drafts WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(CHAT);
        expect(row).toEqual({ status: 'partially_sent', sent_count: 1 });
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver.mock.calls[0][3].content).toMatch(/Only 1 of 2 parts/);
        expect(deliver.mock.calls[0][3].content).toMatch(/Nos vemos mañana/);
        expect(deliver.mock.calls[0][3].content).toMatch(/Autopilot → Drafts/);
    });

    test('a throw with no message, or a bare string, is still a refused send', async () => {
        for (const [thrown, said] of [[new Error(''), /the send threw/], ['boom', /boom/]]) {
            agent.interface.send.mockRejectedValue(thrown);
            deliver.mockClear();
            buffered();
            await service.processBufferedMessage(CHAT, CONTACT);
            expect(draft().status).toBe('pending');
            expect(deliver).toHaveBeenCalledTimes(1);
            expect(deliver.mock.calls[0][3].content).toMatch(said);
        }
    });

    test('a partly sent draft is still the pending draft of that chat, so a reply typed by hand retires it', async () => {
        agent.interface.send.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        buffered();
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(service.getPendingDraft(CHAT)).toMatchObject({ status: 'partially_sent', sent_count: 1 });
    });

    test('a note the ledger already holds in flight is not a warning', async () => {
        agent.interface.send.mockResolvedValue(false);
        deliver.mockResolvedValue({ delivered: false, inFlight: true });
        buffered();
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(console.warn).not.toHaveBeenCalledWith(expect.stringMatching(/note was not delivered/));
    });

    test('a note the ledger could not take is logged, not lost in silence', async () => {
        agent.interface.send.mockResolvedValue(false);
        deliver.mockResolvedValue({ delivered: false, error: 'bad target for whatsapp' });
        buffered();
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/note was not delivered: bad target/));
    });

    test('a send that throws is a failed send too, not a crash', async () => {
        agent.interface.send.mockRejectedValue(new Error('socket closed'));
        buffered();
        await expect(service.processBufferedMessage(CHAT, CONTACT)).resolves.toBeUndefined();
        expect(draft().status).toBe('pending');
        expect(deliver.mock.calls[0][3].content).toMatch(/socket closed/);
    });

    test('with no delivery ledger the owner still hears, from the assistant number', async () => {
        delete agent.delivery;
        db.setAgentSetting('owner_phone', '+10000000000', 'test');
        agent.interface.send.mockImplementation(async (msg) => msg.metadata.chatId !== CHAT);
        buffered();
        await service.processBufferedMessage(CHAT, CONTACT);
        expect(draft().status).toBe('pending');
        const toOwner = agent.interface.send.mock.calls.map(c => c[0]).find(m => m.metadata.chatId === '10000000000@s.whatsapp.net');
        expect(toOwner).toBeDefined();
        expect(toOwner.metadata.session).toBe('assistant');
        expect(toOwner.content).toMatch(/Nothing went out/);
    });
});
