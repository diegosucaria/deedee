/**
 * DeliveryService: first-try success, retries with backoff, the one-time
 * fallback channel, dedupe, dead-letter notification, target formatting and
 * owner target resolution. Real SQLite ledger, fake interface.send.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { DeliveryService, formatTarget, BACKOFF_MS } = require('../src/services/delivery-service');

const OWNER_DIGITS = '5490000000000';
const OWNER_JID = `${OWNER_DIGITS}@s.whatsapp.net`;
const TG_ID = '100000001';
const MIN = 60_000;

describe('DeliveryService', () => {
    let dir, db, agent, svc, env;

    beforeEach(() => {
        env = { ids: process.env.ALLOWED_TELEGRAM_IDS, phone: process.env.MY_PHONE };
        delete process.env.ALLOWED_TELEGRAM_IDS;
        delete process.env.MY_PHONE;
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-16T10:00:00.000Z'));
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-delivery-'));
        db = new AgentDB(dir);
        db.setAgentSetting('owner_phone', `+${OWNER_DIGITS}`);
        db.setAgentSetting('notification_channel', 'whatsapp');
        agent = {
            db,
            settings: {},
            interface: { send: jest.fn().mockResolvedValue(true) },
            notifications: { create: jest.fn().mockReturnValue({ id: 'n1' }) }
        };
        svc = new DeliveryService(agent);
    });

    afterEach(() => {
        svc.stop();
        jest.useRealTimers();
        jest.restoreAllMocks();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        if (env.ids === undefined) delete process.env.ALLOWED_TELEGRAM_IDS; else process.env.ALLOWED_TELEGRAM_IDS = env.ids;
        if (env.phone === undefined) delete process.env.MY_PHONE; else process.env.MY_PHONE = env.phone;
    });

    const sentMessages = () => agent.interface.send.mock.calls.map(c => c[0]);

    describe('formatTarget', () => {
        test('whatsapp gets a JID unless the target already carries one', () => {
            expect(formatTarget('whatsapp', OWNER_DIGITS)).toBe(OWNER_JID);
            expect(formatTarget('whatsapp', `+${OWNER_DIGITS}`)).toBe(OWNER_JID);
            expect(formatTarget('whatsapp', '549 0000 000000')).toBe(OWNER_JID);
            expect(formatTarget('whatsapp', '100000000000001@lid')).toBe('100000000000001@lid');
            expect(formatTarget('whatsapp', 'abc')).toBeNull();
        });

        test('telegram needs a numeric chat id', () => {
            expect(formatTarget('telegram', ' 42 ')).toBe('42');
            expect(formatTarget('telegram', '-1000000000001')).toBe('-1000000000001');
            expect(formatTarget('telegram', OWNER_JID)).toBeNull();
            expect(formatTarget('telegram', '')).toBeNull();
        });

        test('web and slack pass through', () => {
            expect(formatTarget('web', 'socket_1')).toBe('socket_1');
            expect(formatTarget('slack', 'C123')).toBe('C123');
            expect(formatTarget('web', null)).toBeNull();
        });
    });

    describe('deliver: first try succeeds', () => {
        test('sends once, stores a sent row and keeps the interface contract', async () => {
            const res = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'Drink water' }, { origin: 'reminder_1' });
            expect(res).toMatchObject({ delivered: true, status: 'sent', via: 'whatsapp' });

            expect(agent.interface.send).toHaveBeenCalledTimes(1);
            const msg = sentMessages()[0];
            expect(msg).toEqual({
                id: res.id,
                source: 'whatsapp',
                content: 'Drink water',
                type: 'text',
                metadata: { chatId: OWNER_JID, session: 'assistant' },
                isNotification: true
            });

            const row = db.getOutboxRow(res.id);
            expect(row).toMatchObject({ kind: 'reminder', channel: 'whatsapp', target: OWNER_JID, status: 'sent', attempts: 1, delivered_via: 'whatsapp', origin: 'reminder_1' });
            expect(row.sent_at).toBeTruthy();
            expect(agent.notifications.create).not.toHaveBeenCalled();
        });

        test('a whatsapp:user source keeps its session; telegram carries a bare numeric id', async () => {
            await svc.deliver('watcher', 'whatsapp:user', OWNER_JID, { content: 'hi' });
            expect(sentMessages()[0].metadata).toEqual({ chatId: OWNER_JID, session: 'user' });

            await svc.deliver('system_alert', 'telegram', TG_ID, { content: 'hi', caption: 'c' });
            expect(sentMessages()[1]).toMatchObject({ source: 'telegram', metadata: { chatId: TG_ID }, caption: 'c' });
            expect(sentMessages()[1].metadata.session).toBeUndefined();
        });

        test('message-like payloads with inline audio parts become audio sends', async () => {
            const payload = { content: 'ignored', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'QUJD' } }], metadata: { chatId: 'other', foo: 1 } };
            await svc.deliver('reply', 'web', 'socket_1', payload);
            expect(sentMessages()[0]).toMatchObject({ source: 'web', content: 'QUJD', type: 'audio', metadata: { chatId: 'socket_1', foo: 1 } });
        });

        test('rejects unsupported channels, bad targets and empty content without sending', async () => {
            expect(await svc.deliver('reply', 'scheduler', 'x', { content: 'hi' })).toMatchObject({ delivered: false, error: expect.stringContaining('unsupported channel') });
            expect(await svc.deliver('reply', 'telegram', OWNER_JID, { content: 'hi' })).toMatchObject({ delivered: false, error: expect.stringContaining('bad target') });
            expect(await svc.deliver('reply', 'whatsapp', OWNER_JID, { content: '' })).toMatchObject({ delivered: false, error: 'empty content' });
            expect(agent.interface.send).not.toHaveBeenCalled();
            expect(db.countOutboxByStatus()).toEqual({ pending: 0, sent: 0, failed: 0, dead: 0 });
        });
    });

    describe('retries with backoff', () => {
        test('a refused send is retried on the tick schedule 1m, 5m, 15m, 1h, 1h and then dies with one notification', async () => {
            agent.interface.send.mockResolvedValue(false);
            const res = await svc.deliver('job_notification', 'whatsapp', OWNER_DIGITS, { content: 'Agenda' }, { origin: 'morning_briefing' });
            expect(res).toMatchObject({ delivered: false, status: 'failed', queued: true, attempts: 1 });
            expect(agent.interface.send).toHaveBeenCalledTimes(1);

            const row = () => db.getOutboxRow(res.id);
            expect(new Date(row().next_attempt_at).getTime() - Date.now()).toBe(MIN);

            // Not due yet: the tick leaves it alone.
            jest.advanceTimersByTime(30_000);
            expect(await svc.tick()).toEqual({ processed: 0, sent: 0, failed: 0 });
            expect(agent.interface.send).toHaveBeenCalledTimes(1);

            const delays = [MIN, 5 * MIN, 15 * MIN, 60 * MIN, 60 * MIN];
            for (let i = 0; i < delays.length; i++) {
                jest.setSystemTime(new Date(row().next_attempt_at));
                const t = await svc.tick();
                expect(t.processed).toBe(1);
                expect(agent.interface.send).toHaveBeenCalledTimes(i + 2);
                if (i < delays.length - 1) {
                    expect(row().status).toBe('failed');
                    expect(row().attempts).toBe(i + 2);
                    expect(new Date(row().next_attempt_at).getTime() - Date.now()).toBe(delays[i + 1]);
                }
            }

            expect(row().status).toBe('dead');
            expect(row().attempts).toBe(6);
            expect(agent.notifications.create).toHaveBeenCalledTimes(1);
            const n = agent.notifications.create.mock.calls[0][0];
            expect(n).toMatchObject({ type: 'delivery_dead', severity: 'error', title: 'Undelivered notification', message: 'Agenda' });
            expect(n.metadata).toMatchObject({ outboxId: res.id, kind: 'job_notification', channel: 'whatsapp', attempts: 6, origin: 'morning_briefing', link: '/system/notifications' });

            // Dead rows are never picked up again.
            jest.advanceTimersByTime(24 * 60 * MIN);
            expect((await svc.tick()).processed).toBe(0);
        });

        test('a thrown send error counts as a failure with its message', async () => {
            agent.interface.send.mockRejectedValue(new Error('ECONNREFUSED'));
            const res = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'x' });
            expect(res.delivered).toBe(false);
            expect(db.getOutboxRow(res.id).last_error).toBe('ECONNREFUSED');
        });

        test('the retry delivers and the row is sent', async () => {
            agent.interface.send.mockResolvedValueOnce(false).mockResolvedValue(true);
            const res = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'x' });
            jest.advanceTimersByTime(MIN);
            expect(await svc.tick()).toEqual({ processed: 1, sent: 1, failed: 0 });
            expect(db.getOutboxRow(res.id)).toMatchObject({ status: 'sent', attempts: 2, delivered_via: 'whatsapp' });
            // Both attempts reuse the row id so the owner-thread mirror stores one message.
            expect(sentMessages().map(m => m.id)).toEqual([res.id, res.id]);
        });

        test('the worker timer drains due rows', async () => {
            agent.interface.send.mockResolvedValueOnce(false).mockResolvedValue(true);
            svc.start();
            const res = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'x' });
            await jest.advanceTimersByTimeAsync(MIN + 1000);
            expect(db.getOutboxRow(res.id).status).toBe('sent');
            svc.stop();
        });

        test('enqueueFailed stores a first failure without sending again', async () => {
            const res = await svc.enqueueFailed('reply', 'whatsapp', OWNER_JID, { content: 'answer' }, { origin: OWNER_JID, error: 'interface refused' });
            expect(res).toMatchObject({ delivered: false, queued: true, status: 'failed' });
            expect(agent.interface.send).not.toHaveBeenCalled();
            const row = db.getOutboxRow(res.id);
            expect(row.attempts).toBe(1);
            expect(row.last_error).toBe('interface refused');
            expect(new Date(row.next_attempt_at).getTime() - Date.now()).toBe(MIN);
        });

        test('rows past their expiry die instead of being sent', async () => {
            agent.interface.send.mockResolvedValue(false);
            const expiresAt = new Date(Date.now() + 2 * MIN).toISOString();
            const res = await svc.deliver('ask_user', 'whatsapp', OWNER_DIGITS, { content: 'Which one?' }, { expiresAt, dedupe: false });
            jest.advanceTimersByTime(3 * MIN);
            await svc.tick();
            expect(db.getOutboxRow(res.id)).toMatchObject({ status: 'dead', last_error: 'expired before delivery' });
            expect(agent.interface.send).toHaveBeenCalledTimes(1);
            expect(agent.notifications.create).toHaveBeenCalledTimes(1);
        });
    });

    describe('fallback channel', () => {
        beforeEach(() => { process.env.ALLOWED_TELEGRAM_IDS = `${TG_ID}, 100000002`; });

        test('after two WhatsApp failures the payload goes once through Telegram and the row is sent', async () => {
            agent.interface.send.mockImplementation(async (m) => m.source === 'telegram');
            const res = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'Dentist' });
            expect(res.delivered).toBe(false);
            expect(sentMessages().map(m => m.source)).toEqual(['whatsapp']);

            jest.advanceTimersByTime(MIN);
            expect(await svc.tick()).toEqual({ processed: 1, sent: 1, failed: 0 });
            expect(sentMessages().map(m => m.source)).toEqual(['whatsapp', 'whatsapp', 'telegram']);
            expect(sentMessages()[2]).toMatchObject({ id: res.id, content: 'Dentist', metadata: { chatId: TG_ID } });

            const row = db.getOutboxRow(res.id);
            expect(row).toMatchObject({ status: 'sent', delivered_via: 'telegram', fallback_channel: 'telegram', fallback_target: TG_ID, fallback_status: 'sent' });

            // Sent: no more attempts anywhere.
            jest.advanceTimersByTime(60 * MIN);
            expect((await svc.tick()).processed).toBe(0);
            expect(agent.interface.send).toHaveBeenCalledTimes(3);
        });

        test('a failed fallback is not repeated; the primary keeps retrying', async () => {
            agent.interface.send.mockResolvedValue(false);
            const res = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'Dentist' });
            jest.advanceTimersByTime(MIN);
            await svc.tick();
            expect(sentMessages().map(m => m.source)).toEqual(['whatsapp', 'whatsapp', 'telegram']);
            expect(db.getOutboxRow(res.id)).toMatchObject({ status: 'failed', fallback_status: 'failed', last_error: expect.stringContaining('fallback telegram') });

            jest.setSystemTime(new Date(db.getOutboxRow(res.id).next_attempt_at));
            await svc.tick();
            expect(sentMessages().map(m => m.source)).toEqual(['whatsapp', 'whatsapp', 'telegram', 'whatsapp']);
        });

        test('immediateFallback tries the other channel on the first failure', async () => {
            agent.interface.send.mockImplementation(async (m) => m.source === 'telegram');
            const res = await svc.deliver('system_alert', 'whatsapp', OWNER_DIGITS, { content: 'WhatsApp needs repair' }, { immediateFallback: true });
            expect(res).toMatchObject({ delivered: true, via: 'telegram', fallback: true });
            expect(sentMessages().map(m => m.source)).toEqual(['whatsapp', 'telegram']);
        });

        test('telegram as the primary falls back to the owner WhatsApp', async () => {
            db.setAgentSetting('notification_channel', 'telegram');
            agent.interface.send.mockImplementation(async (m) => m.source === 'whatsapp');
            const res = await svc.deliver('job_notification', 'telegram', TG_ID, { content: 'Agenda' }, { immediateFallback: true });
            expect(res).toMatchObject({ delivered: true, via: 'whatsapp' });
            expect(sentMessages()[1]).toMatchObject({ source: 'whatsapp', metadata: { chatId: OWNER_JID, session: 'assistant' } });
        });

        test('a message for someone else never jumps channels', async () => {
            agent.interface.send.mockResolvedValue(false);
            const res = await svc.deliver('reply', 'whatsapp', '5490000000099@s.whatsapp.net', { content: 'hello' });
            jest.advanceTimersByTime(MIN);
            await svc.tick();
            expect(sentMessages().every(m => m.source === 'whatsapp')).toBe(true);
            expect(db.getOutboxRow(res.id).fallback_status).toBeNull();
        });

        test('the owner LID form counts as the owner', () => {
            agent._ownerWaIds = new Set([OWNER_JID, '100000000000001@lid']);
            expect(svc.isOwnerTarget('whatsapp', '100000000000001@lid')).toBe(true);
            expect(svc.isOwnerTarget('whatsapp', '100000000000002@lid')).toBe(false);
            expect(svc.isOwnerTarget('telegram', TG_ID)).toBe(true);
            expect(svc.isOwnerTarget('telegram', '7')).toBe(false);
            expect(svc.isOwnerTarget('web', 'socket_1')).toBe(false);
        });
    });

    describe('dedupe', () => {
        test('the same kind, target and content within 10 minutes is not queued twice', async () => {
            const first = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'Dentist' });
            const again = await svc.deliver('reminder', 'whatsapp', `+${OWNER_DIGITS}`, { content: 'Dentist' });
            expect(again).toMatchObject({ deduped: true, id: first.id, delivered: true });
            expect(agent.interface.send).toHaveBeenCalledTimes(1);

            await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'Dentist tomorrow' });
            await svc.deliver('job_notification', 'whatsapp', OWNER_DIGITS, { content: 'Dentist' });
            expect(agent.interface.send).toHaveBeenCalledTimes(3);

            jest.advanceTimersByTime(11 * MIN);
            await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'Dentist' });
            expect(agent.interface.send).toHaveBeenCalledTimes(4);
        });

        test('a pending duplicate reports queued and dedupe can be turned off', async () => {
            agent.interface.send.mockResolvedValue(false);
            const first = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'Dentist' });
            const dup = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'Dentist' });
            expect(dup).toMatchObject({ deduped: true, id: first.id, delivered: false, queued: true });
            const forced = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'Dentist' }, { dedupe: false });
            expect(forced.deduped).toBeUndefined();
            expect(forced.id).not.toBe(first.id);
        });
    });

    describe('resolveOwnerTarget', () => {
        test('whatsapp by default, from owner_phone', () => {
            expect(svc.resolveOwnerTarget()).toEqual({ channel: 'whatsapp', target: OWNER_JID });
        });

        test('telegram when configured and an allowed id exists; whatsapp otherwise', () => {
            db.setAgentSetting('notification_channel', 'telegram');
            expect(svc.resolveOwnerTarget()).toEqual({ channel: 'whatsapp', target: OWNER_JID });
            process.env.ALLOWED_TELEGRAM_IDS = TG_ID;
            expect(svc.resolveOwnerTarget()).toEqual({ channel: 'telegram', target: TG_ID });
            expect(svc.resolveOwnerTarget('whatsapp')).toEqual({ channel: 'whatsapp', target: OWNER_JID });
        });

        test('no owner_phone: telegram id when present, else null', () => {
            db.setAgentSetting('owner_phone', '');
            expect(svc.resolveOwnerTarget()).toBeNull();
            process.env.ALLOWED_TELEGRAM_IDS = TG_ID;
            expect(svc.resolveOwnerTarget()).toEqual({ channel: 'telegram', target: TG_ID });
            process.env.MY_PHONE = OWNER_DIGITS;
            expect(svc.resolveOwnerTarget()).toEqual({ channel: 'whatsapp', target: OWNER_JID });
        });
    });

    describe('retryNow and listing', () => {
        test('retryNow revives a dead row and tries at once; sent rows are left alone', async () => {
            agent.interface.send.mockResolvedValue(false);
            const res = await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'x' });
            db.deadLetterOutbox(res.id, 'gave up');
            agent.interface.send.mockResolvedValue(true);
            const retry = await svc.retryNow(res.id);
            expect(retry).toMatchObject({ delivered: true, row: expect.objectContaining({ status: 'sent' }) });
            expect(await svc.retryNow(res.id)).toBeNull();
            expect(await svc.retryNow('missing')).toBeNull();
        });

        test('listRecent and counts read the ledger', async () => {
            await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'a' });
            agent.interface.send.mockResolvedValue(false);
            await svc.deliver('reminder', 'whatsapp', OWNER_DIGITS, { content: 'b' });
            expect(svc.counts()).toEqual({ pending: 0, sent: 1, failed: 1, dead: 0 });
            expect(svc.listRecent(10).length).toBe(2);
            expect(svc.listRecent(10, 'failed').length).toBe(1);
        });
    });

    describe('without a ledger', () => {
        test('a stub DB still gets one direct send plus the immediate fallback', async () => {
            process.env.ALLOWED_TELEGRAM_IDS = TG_ID;
            agent.db = { getAllAgentSettings: () => ({ owner_phone: OWNER_DIGITS }) };
            agent.interface.send.mockImplementation(async (m) => m.source === 'telegram');
            const plain = await svc.deliver('system_alert', 'whatsapp', OWNER_DIGITS, { content: 'x' });
            expect(plain).toMatchObject({ delivered: false, ledger: false });
            const withFallback = await svc.deliver('system_alert', 'whatsapp', OWNER_DIGITS, { content: 'x' }, { immediateFallback: true });
            expect(withFallback).toMatchObject({ delivered: true, via: 'telegram', ledger: false });
            expect(await svc.enqueueFailed('reply', 'whatsapp', OWNER_DIGITS, { content: 'x' })).toMatchObject({ delivered: false, error: 'no ledger' });
            expect(await svc.tick()).toEqual({ processed: 0 });
            expect(await svc.retryNow('x')).toBeNull();
            expect(svc.counts()).toEqual({ pending: 0, sent: 0, failed: 0, dead: 0 });
        });
    });
});
