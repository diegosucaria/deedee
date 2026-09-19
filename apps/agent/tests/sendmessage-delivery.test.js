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
        expect(out).toMatchObject({ success: true, queued: true, status: 'queued' });
        expect(out.info).toMatch(/Not delivered .* yet/);
        // He may read this line himself, so it states facts and gives no orders.
        expect(out.info).toMatch(/should not be sent again/);
        expect(out.info).not.toMatch(/\bdo not\b|\bSay so\b/i);
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
        expect(db.listRecentOutbox({ limit: 5 }).map(r => r.status)).toEqual(['sent', 'sent']);
    });

    test('a model that retries after "queued" does not get him the briefing twice', async () => {
        send.mockResolvedValue(false);
        const first = await toOwner();
        const second = await toOwner();
        expect(first.queued).toBe(true);
        expect(second).toMatchObject({ success: true, queued: true });
        // One row waits, not two, so one copy goes out when the service returns.
        expect(db.listRecentOutbox({ limit: 5 })).toHaveLength(1);
    });

    test('a send that cannot be delivered or queued is a failure', async () => {
        // The ledger refuses an empty text outright.
        const out = await toOwner({ content: '' });
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/nothing is queued/);
        expect(send).not.toHaveBeenCalled();
        expect(db.listRecentOutbox({ limit: 5 })).toHaveLength(0);
    });

    test('a chat send is filed as a reply, with its own origin', async () => {
        await executor.execute('sendMessage', { to: OWNER_DIGITS, content: 'note to self' }, { message: { source: 'web', metadata: { chatId: 'web-1' } } });
        expect(db.listRecentOutbox({ limit: 5 })[0]).toMatchObject({ kind: 'reply', origin: 'sendMessage', status: 'sent' });
    });

    test('a database that cannot take the row does not cost him the message', async () => {
        jest.spyOn(db, 'enqueueOutbox').mockImplementation(() => { throw new Error('disk full'); });
        const out = await toOwner();
        expect(out).toMatchObject({ success: true });
        expect(send).toHaveBeenCalledTimes(1);
    });

    describe('pictures', () => {
        let img, oldDataDir;
        beforeEach(() => {
            img = path.join(dir, 'pic.png');
            fs.writeFileSync(img, 'png-bytes');
            oldDataDir = process.env.DATA_DIR;
            process.env.DATA_DIR = dir;
        });
        afterEach(() => { if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir; });

        test('a picture to the owner keeps its caption and leaves no megabyte row', async () => {
            const out = await toOwner({ type: 'image', imagePath: img, content: 'the caption' });
            expect(out).toMatchObject({ success: true });
            expect(send).toHaveBeenCalledTimes(1);
            expect(send.mock.calls[0][0]).toMatchObject({ type: 'image', caption: 'the caption', content: Buffer.from('png-bytes').toString('base64') });
            // The ledger holds text only: a picture row would be megabytes of base64.
            expect(db.listRecentOutbox({ limit: 5 })).toHaveLength(0);
        });

        test('a refused picture still gets him the words, through the ledger', async () => {
            send.mockResolvedValueOnce(false).mockResolvedValue(true);
            const out = await toOwner({ type: 'image', imagePath: img, content: 'Good morning! Here is your daily briefing:' });
            expect(out).toMatchObject({ success: true, status: 'partial' });
            expect(out.info).toMatch(/picture .* was not delivered\. Its text went out/);
            const [row] = db.listRecentOutbox({ limit: 5 });
            expect(row).toMatchObject({ kind: 'job_notification', status: 'sent' });
            expect(row.payload).toMatchObject({ type: 'text', content: 'Good morning! Here is your daily briefing:' });
        });

        test('with the service down, the words are queued and the model is told', async () => {
            send.mockResolvedValue(false);
            const out = await toOwner({ type: 'image', imagePath: img, content: 'the words' });
            expect(out).toMatchObject({ success: true, queued: true, status: 'queued' });
            expect(out.info).toMatch(/Its text is queued/);
            expect(db.listRecentOutbox({ limit: 5 })).toHaveLength(1);
        });

        test('a refused picture with no words is a failure', async () => {
            send.mockResolvedValue(false);
            const out = await toOwner({ type: 'image', imagePath: img, content: '' });
            expect(out.success).toBe(false);
            expect(db.listRecentOutbox({ limit: 5 })).toHaveLength(0);
        });
    });

    test('a contact gets one try: a refused send is a failure, not queued, never "sent"', async () => {
        jest.spyOn(db, 'isVerifiedContact').mockReturnValue(true);
        send.mockResolvedValue(false);
        const out = await executor.execute('sendMessage', { to: CONTACT_DIGITS, content: 'on my way' }, { message: { source: 'web', metadata: { chatId: 'web-1' } } });
        expect(out.success).toBe(false);
        // A refusal and a timeout look alike, so it may have landed.
        expect(out.error).toMatch(/may not have been delivered/);
        expect(out.error).toMatch(/not queued/);
        expect(out.error).toMatch(/should not be sent again before checking/);
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
