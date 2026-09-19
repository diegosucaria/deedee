/**
 * sendMessage used to ignore a refused send and report success. A job sends
 * its briefing with sendMessage and then answers [SILENT], so with the
 * messaging service down the briefing was lost and nothing said so.
 *
 * A message to the owner now goes through the delivery ledger. A message to
 * a contact gets one try, and a failed try is reported.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { DeliveryService } = require('../src/services/delivery-service');
const { CommunicationExecutor } = require('../src/executors/communication');

const OWNER_DIGITS = '10000000000';
const OWNER_JID = `${OWNER_DIGITS}@s.whatsapp.net`;
const CONTACT_DIGITS = '10000000001';

describe('sendMessage delivery', () => {
    let dir, db, agent, executor, send, spies;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-sendmsg-'));
        db = new AgentDB(dir);
        send = jest.fn().mockResolvedValue(true);
        agent = {
            db,
            settings: { owner_phone: `+${OWNER_DIGITS}`, notification_channel: 'whatsapp' },
            interface: { send },
            notifications: { create: jest.fn() },
        };
        agent.delivery = new DeliveryService(agent);
        const services = { interface: agent.interface, db, agent };
        executor = new CommunicationExecutor(services);
        // The owner's own number and the contact are known already; the
        // first-contact safeguard has its own tests.
        jest.spyOn(db, 'isVerifiedContact').mockReturnValue(true);
        spies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        agent.delivery.stop?.();
        spies.forEach(s => s.mockRestore());
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const jobMessage = { source: 'scheduler', metadata: { chatId: 'scheduled_morning_briefing_1', jobName: 'morning_briefing' } };
    const toOwner = (extra = {}) => executor.execute('sendMessage', { to: OWNER_DIGITS, content: 'Good morning!', ...extra }, { message: jobMessage });

    test('a message to the owner that goes out is a success, sent once', async () => {
        const out = await toOwner();
        expect(out).toMatchObject({ success: true });
        expect(out.queued).toBeUndefined();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toMatchObject({ source: 'whatsapp', content: 'Good morning!', metadata: { chatId: OWNER_JID, session: 'assistant' } });
        const [row] = db.listRecentOutbox({ limit: 5 });
        expect(row).toMatchObject({ kind: 'job_notification', status: 'sent', origin: 'job:morning_briefing' });
    });

    test('a refused send to the owner is queued for retry, and the model is told the truth', async () => {
        send.mockResolvedValue(false);
        const out = await toOwner();
        // Not "Message sent": it has not been.
        expect(out).toMatchObject({ success: true, queued: true });
        expect(out.info).toMatch(/Not delivered .* yet/);
        expect(out.info).toMatch(/do not send it again/);
        const [row] = db.listRecentOutbox({ limit: 5 });
        expect(['pending', 'failed']).toContain(row.status);
        expect(row.target).toBe(OWNER_JID);
    });

    test('the queued briefing goes out once the service is back', async () => {
        send.mockResolvedValue(false);
        await toOwner();
        send.mockResolvedValue(true);
        // Make the row due now, then run the ledger's own tick.
        const [queued] = db.listRecentOutbox({ limit: 5 });
        db.db.prepare('UPDATE notification_outbox SET next_attempt_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), queued.id);
        await agent.delivery.tick();
        const [row] = db.listRecentOutbox({ limit: 5 });
        expect(row.status).toBe('sent');
        expect(send.mock.calls.at(-1)[0]).toMatchObject({ content: 'Good morning!', metadata: { chatId: OWNER_JID } });
    });

    test('the same text twice is sent twice: the model asked for both', async () => {
        await toOwner();
        await toOwner();
        expect(send).toHaveBeenCalledTimes(2);
    });

    test('a picture to the owner keeps its caption', async () => {
        const img = path.join(dir, 'pic.png');
        fs.writeFileSync(img, 'png-bytes');
        const old = process.env.DATA_DIR;
        process.env.DATA_DIR = dir;
        try {
            const out = await toOwner({ type: 'image', imagePath: img, content: 'the caption' });
            expect(out).toMatchObject({ success: true });
            expect(send.mock.calls[0][0]).toMatchObject({ type: 'image', caption: 'the caption', content: Buffer.from('png-bytes').toString('base64') });
        } finally {
            if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old;
        }
    });

    test('a contact gets one try: a refused send is a failure, not queued, never "sent"', async () => {
        jest.spyOn(db, 'isVerifiedContact').mockReturnValue(true);
        send.mockResolvedValue(false);
        const out = await executor.execute('sendMessage', { to: CONTACT_DIGITS, content: 'on my way' }, { message: { source: 'web', metadata: { chatId: 'web-1' } } });
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/was not delivered/);
        expect(out.error).toMatch(/not queued/);
        expect(db.listRecentOutbox({ limit: 5 })).toHaveLength(0);
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('a contact message that goes out is unchanged', async () => {
        jest.spyOn(db, 'isVerifiedContact').mockReturnValue(true);
        const out = await executor.execute('sendMessage', { to: CONTACT_DIGITS, content: 'hello' }, { message: { source: 'web', metadata: { chatId: 'web-1' } } });
        expect(out).toMatchObject({ success: true, info: `Message sent to ${CONTACT_DIGITS}` });
        expect(db.listRecentOutbox({ limit: 5 })).toHaveLength(0);
    });

    test('with no ledger on the agent, the owner path still reports a refused send', async () => {
        const bare = new CommunicationExecutor({ interface: { send: jest.fn().mockResolvedValue(false) }, db });
        jest.spyOn(db, 'isVerifiedContact').mockReturnValue(true);
        const out = await bare.execute('sendMessage', { to: OWNER_DIGITS, content: 'x' }, { message: {} });
        expect(out.success).toBe(false);
    });
});
