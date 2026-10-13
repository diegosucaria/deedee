/**
 * The interfaces service tells the owner when a WhatsApp session has been
 * down for 15 minutes, and again when it is back. Each alert names its
 * outage (whatsapp_down:<session>:<outage>). The ledger decides "back": it
 * goes out only when that outage's "down" row was sent.
 *
 * Faults this guards against:
 * - with one key per session, the 6 h repeat filter hid a second outage, or
 *   let "back" come with no "down" before it;
 * - with a "still down" mark per session in memory, a restart or a reset
 *   (no "back" sent) left the mark set and the next outage went unreported,
 *   and a restarted agent forgot a "down" it had sent;
 * - a "down" still queued (or still being sent) when the session came back
 *   arrived after "back", or came back to life after it was retired;
 * - a "down" that died in the ledger was followed by a lone "back".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent');
const { AgentDB } = require('../src/db');
const { DeliveryService } = require('../src/services/delivery-service');

const OWNER_DIGITS = '10000000000';

describe('WhatsApp outage alerts', () => {
    let dir, db, agent, send, spies, envBefore;

    const makeAgent = () => {
        // The real deliverSystemAlert, ledger and database; a stub interface.
        const a = Object.create(Agent.prototype);
        Object.assign(a, {
            db,
            settings: { owner_phone: `+${OWNER_DIGITS}`, notification_channel: 'whatsapp' },
            interface: { send },
            notifications: { create: jest.fn().mockReturnValue({ id: 'n1' }) },
            _outageWaitStepMs: 5,
        });
        a.delivery = new DeliveryService(a);
        return a;
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-outage-'));
        db = new AgentDB(dir);
        send = jest.fn().mockResolvedValue(true);
        envBefore = { tg: process.env.ALLOWED_TELEGRAM_IDS, phone: process.env.MY_PHONE };
        delete process.env.ALLOWED_TELEGRAM_IDS;
        agent = makeAgent();
        spies = ['log', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation(() => { }));
    });

    afterEach(() => {
        agent.delivery.stop?.();
        spies.forEach(s => s.mockRestore());
        for (const [k, v] of [['ALLOWED_TELEGRAM_IDS', envBefore.tg], ['MY_PHONE', envBefore.phone]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const said = () => send.mock.calls.map(c => c[0].content);
    const alert = (text, key) => agent.deliverSystemAlert(text, key);
    const tickDue = async () => {
        db.db.prepare("UPDATE notification_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status IN ('pending', 'failed')").run();
        await agent.delivery.tick();
    };

    test('every outage is told once, and its "back" only after its "down"', async () => {
        expect(await alert('back?', 'whatsapp_up:assistant:o0')).toBe(false);

        expect(await alert('down 1', 'whatsapp_down:assistant:o1')).toBe(true);
        // A retry of the same outage is not told twice.
        expect(await alert('down 1', 'whatsapp_down:assistant:o1')).toBe(false);
        expect(await alert('back 1', 'whatsapp_up:assistant:o1')).toBe(true);
        expect(await alert('back 1', 'whatsapp_up:assistant:o1')).toBe(false);

        // A second outage the same hour is told, and so is its end.
        expect(await alert('down 2', 'whatsapp_down:assistant:o2')).toBe(true);
        expect(await alert('back 2', 'whatsapp_up:assistant:o2')).toBe(true);
        // The other session has its own outages.
        expect(await alert('user down', 'whatsapp_down:user:o3')).toBe(true);

        expect(said()).toEqual(['down 1', 'back 1', 'down 2', 'back 2', 'user down']);
    });

    test('an outage with no "back" (a restart, a reset) does not hide the next one', async () => {
        expect(await alert('down 1', 'whatsapp_down:assistant:o1')).toBe(true);
        // The interfaces service restarted, or he re-paired: no "back" for o1.
        expect(await alert('down 2', 'whatsapp_down:assistant:o2')).toBe(true);
        expect(await alert('back 2', 'whatsapp_up:assistant:o2')).toBe(true);
        expect(said()).toEqual(['down 1', 'down 2', 'back 2']);
    });

    test('a restarted agent still sends "back" for a "down" it sent before', async () => {
        expect(await alert('down 1', 'whatsapp_down:assistant:o1')).toBe(true);
        agent.delivery.stop?.();
        agent = makeAgent();
        expect(await alert('back 1', 'whatsapp_up:assistant:o1')).toBe(true);
        expect(said()).toEqual(['down 1', 'back 1']);
    });

    test('a "down" still queued when the session is back is dropped, and so is the "back", even after a restart', async () => {
        // WhatsApp (his alert channel) is the session that is down, and there
        // is no Telegram: the "down" waits in the ledger.
        send.mockResolvedValue(false);
        expect(await alert('down 1', 'whatsapp_down:assistant:o1')).toBe(true);
        const [row] = db.listRecentOutbox({ limit: 5 });
        expect(row.status).toBe('failed');

        agent.delivery.stop?.();
        agent = makeAgent();
        send.mockResolvedValue(true);
        expect(await alert('back 1', 'whatsapp_up:assistant:o1')).toBe(false);
        expect(db.getOutboxRow(row.id).status).toBe('dead');

        // The ledger does not send the stale "down" later.
        const before = send.mock.calls.length;
        await tickDue();
        expect(send.mock.calls.length).toBe(before);
    });

    test('a "down" being sent when "back" comes decides it: sent, then "back" follows', async () => {
        let finish;
        send.mockImplementationOnce(() => new Promise(r => { finish = r; }));
        const down = alert('down 1', 'whatsapp_down:assistant:o1');
        const back = alert('back 1', 'whatsapp_up:assistant:o1');
        await new Promise(r => setTimeout(r, 30));
        finish(true);
        expect(await down).toBe(true);
        expect(await back).toBe(true);
        expect(said()).toEqual(['down 1', 'back 1']);
    });

    test('a "down" being sent when "back" comes and failing is retired, and never sent later', async () => {
        let finish;
        send.mockImplementationOnce(() => new Promise(r => { finish = r; }));
        const down = alert('down 1', 'whatsapp_down:assistant:o1');
        const back = alert('back 1', 'whatsapp_up:assistant:o1');
        await new Promise(r => setTimeout(r, 30));
        finish(false);
        await down;
        expect(await back).toBe(false);
        const before = send.mock.calls.length;
        await tickDue();
        expect(send.mock.calls.length).toBe(before);
        expect(db.listRecentOutbox({ limit: 5 })[0].status).toBe('dead');
    });

    test('a "down" the ledger gave up on is not followed by a lone "back"', async () => {
        send.mockResolvedValue(false);
        expect(await alert('down 1', 'whatsapp_down:assistant:o1')).toBe(true);
        const [row] = db.listRecentOutbox({ limit: 5 });
        db.deadLetterOutbox(row.id, 'gave up after 6 attempts');
        send.mockResolvedValue(true);
        expect(await alert('back 1', 'whatsapp_up:assistant:o1')).toBe(false);
    });

    test('a "down" that reached no one is not counted, so its "back" stays quiet', async () => {
        // No owner channel at all and the dashboard write fails.
        agent.settings = {};
        delete process.env.MY_PHONE;
        agent.notifications.create.mockReturnValue(null);
        expect(await alert('down 1', 'whatsapp_down:assistant:o1')).toBe(false);
        agent.settings = { owner_phone: `+${OWNER_DIGITS}`, notification_channel: 'whatsapp' };
        expect(await alert('back 1', 'whatsapp_up:assistant:o1')).toBe(false);
        expect(said()).toEqual([]);
    });
});
