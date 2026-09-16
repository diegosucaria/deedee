/**
 * askUser: routing, answer, timeout, cancel, expire-on-boot and sub-agent
 * rules, with a real SQLite DB and a fake interface.send.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDB } = require('../src/db');
const { AskUserService, clampTimeoutSeconds, looksLikeLateAnswer } = require('../src/services/ask-user');

const OWNER_DIGITS = '10000000000';
const OWNER_JID = `${OWNER_DIGITS}@s.whatsapp.net`;

function makeAgent(db, settings = {}) {
    return {
        db,
        settings: { owner_phone: `+${OWNER_DIGITS}`, notification_channel: 'whatsapp', ...settings },
        interface: {
            send: jest.fn().mockResolvedValue(true),
            broadcast: jest.fn().mockResolvedValue(true)
        },
        notifications: { create: jest.fn() },
        stopFlags: new Set(),
        cancellationFlags: new Set()
    };
}

const webMsg = (chatId, content = 'check my bill') => ({
    role: 'user', content, source: 'web', metadata: { chatId }
});
const reply = (chatId, content, source = 'web') => ({
    id: `m-${Math.random()}`, role: 'user', content, source, metadata: { chatId }, timestamp: new Date().toISOString()
});

const flush = () => new Promise(r => setImmediate(r));

describe('AskUserService', () => {
    let dir, db, agent, svc;

    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-askuser-'));
        db = new AgentDB(dir);
        agent = makeAgent(db);
        svc = new AskUserService(agent);
    });

    afterEach(() => {
        svc.cancelAll();
        jest.useRealTimers();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('route', () => {
        test('web and whatsapp assistant chats reply in the origin chat', () => {
            expect(svc.route(webMsg('chat-1'))).toEqual({ replyChatId: 'chat-1', replySource: 'web' });
            expect(svc.route({ source: 'whatsapp:assistant', metadata: { chatId: 'x@s.whatsapp.net' } }))
                .toEqual({ replyChatId: 'x@s.whatsapp.net', replySource: 'whatsapp:assistant' });
            expect(svc.route({ source: 'telegram', metadata: { chatId: '42' } }))
                .toEqual({ replyChatId: '42', replySource: 'telegram' });
        });

        test('scheduler and system runs go to the owner channel', () => {
            const r = svc.route({ source: 'scheduler', metadata: { chatId: 'job-1' } });
            expect(r).toEqual({ replyChatId: OWNER_JID, replySource: 'whatsapp', ownerChannel: true });
            expect(svc.route({ source: 'system', metadata: {} }).replyChatId).toBe(OWNER_JID);
            // A watcher run comes from a contact's chat; never ask the contact.
            expect(svc.route({ source: 'whatsapp:user', metadata: { chatId: 'contact@s.whatsapp.net' } }).replyChatId).toBe(OWNER_JID);
        });

        test('no owner phone means no route', () => {
            agent.settings = {};
            delete process.env.MY_PHONE;
            expect(svc.route({ source: 'scheduler', metadata: {} }).error).toMatch(/owner_phone/);
        });

        test('sub-agent uses the parent chat when the parent is a live chat', () => {
            const sub = { source: 'subagent', metadata: { chatId: 'subagent-sub-1', isSubAgent: true, parentChatId: 'chat-1', parentSource: 'web' } };
            expect(svc.route(sub)).toEqual({ replyChatId: 'chat-1', replySource: 'web' });
        });

        test('sub-agent falls back to the parent chat history for the source', () => {
            db.saveMessage(reply('chat-9', 'hi', 'telegram'));
            const sub = { source: 'subagent', metadata: { chatId: 'subagent-sub-1', isSubAgent: true, parentChatId: 'chat-9' } };
            expect(svc.route(sub)).toEqual({ replyChatId: 'chat-9', replySource: 'telegram' });
        });

        test('sub-agent of a scheduler run or a nested sub-agent gets an error', () => {
            const fromJob = { source: 'subagent', metadata: { isSubAgent: true, parentChatId: 'job-1', parentSource: 'scheduler' } };
            expect(svc.route(fromJob)).toEqual({ error: 'askUser unavailable; report what you need to the parent' });
            const nested = { source: 'subagent', metadata: { isSubAgent: true, parentChatId: 'subagent-sub-1', parentSource: 'subagent' } };
            expect(svc.route(nested).error).toMatch(/unavailable/);
        });
    });

    describe('ask and answer', () => {
        test('sends the question through interface.send with metadata.question and waits for the reply', async () => {
            const pending = svc.ask(webMsg('chat-1'), { question: 'Which account?', options: ['Personal', 'Work'] });
            await flush();

            expect(agent.interface.send).toHaveBeenCalledTimes(1);
            const sent = agent.interface.send.mock.calls[0][0];
            expect(sent.source).toBe('web');
            expect(sent.role).toBe('assistant');
            expect(sent.content).toBe('Which account?\n1. Personal\n2. Work');
            expect(sent.metadata.chatId).toBe('chat-1');
            expect(sent.metadata.question).toEqual({ id: expect.any(String), options: ['Personal', 'Work'] });

            const row = db.getPendingQuestion('chat-1');
            expect(row.status).toBe('pending');
            expect(row.id).toBe(sent.metadata.question.id);
            expect(JSON.parse(row.options)).toEqual(['Personal', 'Work']);
            expect(row.source).toBe('web');
            expect(row.chat_id).toBe('chat-1');

            expect(agent.notifications.create).toHaveBeenCalledWith(expect.objectContaining({
                type: 'ask_user', message: 'Which account?',
                metadata: expect.objectContaining({ chatId: 'chat-1', link: '/chat/chat-1' })
            }));
            expect(agent.interface.broadcast).toHaveBeenCalledWith('agent:question', expect.objectContaining({
                id: row.id, chatId: 'chat-1', question: 'Which account?', options: ['Personal', 'Work']
            }));
            // The question itself is in the chat history
            expect(db.getHistoryForChat('chat-1', 5).map(m => m.role)).toEqual(['model']);

            // Fake time stands still; move it so the answer sorts after the question.
            jest.advanceTimersByTime(10);
            const cb = jest.fn().mockResolvedValue();
            const ack = await svc.intercept(reply('chat-1', 'Work'), cb);
            expect(ack.content).toBe('Got it.');
            expect(ack.metadata.chatId).toBe('chat-1');
            expect(cb).toHaveBeenCalledWith(ack);

            await expect(pending).resolves.toEqual({ answer: 'Work' });
            const closed = db.db.prepare('SELECT * FROM pending_questions WHERE id = ?').get(row.id);
            expect(closed.status).toBe('answered');
            expect(closed.answer).toBe('Work');
            expect(closed.answered_at).toBeTruthy();
            expect(svc.hasPending('chat-1')).toBe(false);
            // The user's answer is saved to history
            expect(db.getHistoryForChat('chat-1', 5).map(m => m.role)).toEqual(['model', 'user']);
        });

        test('a number picks an option; free text is the answer as typed', async () => {
            const p1 = svc.ask(webMsg('chat-1'), { question: 'Yes or no?', options: ['Yes', 'No'] });
            await flush();
            await svc.intercept(reply('chat-1', '2'), jest.fn());
            await expect(p1).resolves.toEqual({ answer: 'No' });

            const p2 = svc.ask(webMsg('chat-1'), { question: 'Code?' });
            await flush();
            await svc.intercept(reply('chat-1', '482913'), jest.fn());
            await expect(p2).resolves.toEqual({ answer: '482913' });
        });

        test('messages in other chats, slash commands and multimodal input are not answers', async () => {
            const pending = svc.ask(webMsg('chat-1'), { question: 'Code?' });
            await flush();
            expect(await svc.intercept(reply('chat-2', '1234'), jest.fn())).toBeNull();
            expect(await svc.intercept(reply('chat-1', '/status'), jest.fn())).toBeNull();
            expect(await svc.intercept({ role: 'user', parts: [{ text: 'x' }], source: 'web', metadata: { chatId: 'chat-1' } }, jest.fn())).toBeNull();
            expect(svc.hasPending('chat-1')).toBe(true);
            svc.cancelAll();
            await expect(pending).resolves.toEqual({ cancelled: true });
        });

        test('only one open question per reply chat', async () => {
            const first = svc.ask(webMsg('chat-1'), { question: 'One?' });
            await flush();
            await expect(svc.ask(webMsg('chat-1'), { question: 'Two?' })).resolves.toEqual({ error: expect.stringMatching(/already waiting/) });
            expect(agent.interface.send).toHaveBeenCalledTimes(1);
            svc.cancelAll();
            await first;
        });

        test('a refused send keeps the question open; the ledger retries until the timeout', async () => {
            agent.interface.send.mockResolvedValue(false);
            const pending = svc.ask(webMsg('chat-1'), { question: 'Code?', timeoutSeconds: 30 });
            await flush();

            const row = db.getPendingQuestion('chat-1');
            expect(row.status).toBe('pending');
            const outbox = db.listRecentOutbox({ limit: 5 });
            expect(outbox).toHaveLength(1);
            expect(outbox[0]).toMatchObject({ kind: 'ask_user', channel: 'web', target: 'chat-1', status: 'failed', attempts: 1, expires_at: row.expires_at });
            // The row id is the message id saved in the chat, so retries add no copies.
            expect(db.getHistoryForChat('chat-1', 5).map(m => m.id)).toEqual([outbox[0].id]);
            expect(agent.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'ask_user' }));

            jest.advanceTimersByTime(30_000);
            await expect(pending).resolves.toEqual({ timeout: true, delivered: false });
            expect(db.db.prepare('SELECT status FROM pending_questions WHERE id = ?').get(row.id).status).toBe('timeout');
        });

        test('without a ledger a refused send closes the row and returns an error', async () => {
            agent.interface.send.mockResolvedValue(false);
            db.enqueueOutbox = null; // hide the ledger helpers on this instance
            try {
                await expect(svc.ask(webMsg('chat-1'), { question: 'Code?' })).resolves.toEqual({ error: expect.stringMatching(/deliver/) });
                expect(db.getPendingQuestion('chat-1')).toBeUndefined();
            } finally {
                delete db.enqueueOutbox;
            }
        });

        test('an empty question is rejected without a send', async () => {
            await expect(svc.ask(webMsg('chat-1'), {})).resolves.toEqual({ error: expect.stringMatching(/question/) });
            expect(agent.interface.send).not.toHaveBeenCalled();
        });
    });

    describe('owner channel and sub-agents', () => {
        test('a scheduler run sends to the owner on WhatsApp as a notification', async () => {
            const job = { source: 'scheduler', metadata: { chatId: 'job-1', jobName: 'bills' } };
            const pending = svc.ask(job, { question: 'SMS code?' });
            await flush();
            const sent = agent.interface.send.mock.calls[0][0];
            expect(sent.source).toBe('whatsapp');
            expect(sent.isNotification).toBe(true);
            expect(sent.metadata).toEqual({ chatId: OWNER_JID, session: 'assistant', question: { id: expect.any(String), options: [] } });
            const row = db.getPendingQuestion(OWNER_JID);
            expect(row.chat_id).toBe('job-1');
            expect(row.reply_source).toBe('whatsapp');

            await svc.intercept(reply(OWNER_JID, '777', 'whatsapp:assistant'), jest.fn());
            await expect(pending).resolves.toEqual({ answer: '777' });
        });

        test('an owner reply under a LID JID still matches the phone JID question', async () => {
            agent._getOwnerWaIds = jest.fn().mockResolvedValue(new Set([OWNER_JID, '999@lid']));
            agent._normalizeWaChatId = (c) => c;
            const pending = svc.ask({ source: 'scheduler', metadata: { chatId: 'job-1' } }, { question: 'Code?' });
            await flush();
            await svc.intercept(reply('999@lid', '4242', 'whatsapp:assistant'), jest.fn());
            await expect(pending).resolves.toEqual({ answer: '4242' });
        });

        describe('answers from the other owner channel', () => {
            const TG_ID = '100000001';
            let envIds;
            beforeEach(() => {
                envIds = process.env.ALLOWED_TELEGRAM_IDS;
                process.env.ALLOWED_TELEGRAM_IDS = `${TG_ID}, 100000002`;
                agent._getOwnerWaIds = jest.fn().mockResolvedValue(new Set([OWNER_JID]));
                agent._normalizeWaChatId = (c) => c;
                jest.spyOn(console, 'warn').mockImplementation(() => { });
            });
            afterEach(() => {
                if (envIds === undefined) delete process.env.ALLOWED_TELEGRAM_IDS; else process.env.ALLOWED_TELEGRAM_IDS = envIds;
            });
            const job = { source: 'scheduler', metadata: { chatId: 'job-1' } };
            const tgMsg = (text, id = TG_ID) => reply(id, text, 'telegram');

            test('a Telegram message does not answer a WhatsApp question the owner never got', async () => {
                agent.interface.send.mockResolvedValue(false);
                const pending = svc.ask(job, { question: 'Code?', timeoutSeconds: 30 });
                await flush();
                expect(db.getOutboxRow(agent.interface.send.mock.calls[0][0].id)).toMatchObject({ status: 'failed', channel: 'whatsapp' });

                const cb = jest.fn();
                // The owner's unrelated Telegram message reaches the model untouched.
                expect(await svc.intercept(tgMsg('turn off the lights'), cb)).toBeNull();
                expect(cb).not.toHaveBeenCalled();
                expect(db.getPendingQuestion(OWNER_JID).status).toBe('pending');
                // A second person in ALLOWED_TELEGRAM_IDS does not count either.
                expect(await svc.intercept(tgMsg('hola', '100000002'), cb)).toBeNull();

                jest.advanceTimersByTime(30_000);
                await expect(pending).resolves.toEqual({ timeout: true, delivered: false });
            });

            test('a Telegram message does not answer a question that reached the owner on WhatsApp', async () => {
                const pending = svc.ask(job, { question: 'Code?' });
                await flush();
                expect(db.getOutboxRow(agent.interface.send.mock.calls[0][0].id)).toMatchObject({ status: 'sent', delivered_via: 'whatsapp' });

                expect(await svc.intercept(tgMsg('4242'), jest.fn())).toBeNull();
                expect(db.getPendingQuestion(OWNER_JID).status).toBe('pending');
                // The owner's own WhatsApp answer still closes it.
                await svc.intercept(reply(OWNER_JID, '4242', 'whatsapp:assistant'), jest.fn());
                await expect(pending).resolves.toEqual({ answer: '4242' });
            });

            test('once the ledger falls back to Telegram, the Telegram answer counts', async () => {
                agent.interface.send.mockImplementation(async (m) => m.source === 'telegram');
                const pending = svc.ask(job, { question: 'Code?', timeoutSeconds: 600 });
                await flush();
                const outboxId = agent.interface.send.mock.calls[0][0].id;
                expect(await svc.intercept(tgMsg('4242'), jest.fn())).toBeNull();

                // Second failure on WhatsApp -> the ledger tries Telegram, which accepts.
                const delivery = agent.delivery;
                db.db.prepare('UPDATE notification_outbox SET next_attempt_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), outboxId);
                await delivery.tick();
                expect(db.getOutboxRow(outboxId)).toMatchObject({ status: 'sent', delivered_via: 'telegram', fallback_channel: 'telegram' });

                const cb = jest.fn();
                const ack = await svc.intercept(tgMsg('4242'), cb);
                expect(ack.content).toBe('Got it.');
                await expect(pending).resolves.toEqual({ answer: '4242' });
            });

            test('the configured owner channel always counts for a job question, even before delivery', async () => {
                agent.settings.notification_channel = 'telegram';
                agent.interface.send.mockResolvedValue(false);
                const pending = svc.ask(job, { question: 'Code?', timeoutSeconds: 30 });
                await flush();
                expect(db.getPendingQuestion(TG_ID)).toMatchObject({ reply_source: 'telegram' });

                // WhatsApp did not carry the question: the owner's WhatsApp message is not the answer.
                expect(await svc.intercept(reply(OWNER_JID, 'hola', 'whatsapp:assistant'), jest.fn())).toBeNull();
                // The second allowed Telegram id is the owner channel: it answers.
                await svc.intercept(tgMsg('4242', '100000002'), jest.fn());
                await expect(pending).resolves.toEqual({ answer: '4242' });
            });
        });

        test('a sub-agent question reaches the parent chat and its reply answers it', async () => {
            const sub = { source: 'subagent', metadata: { chatId: 'subagent-sub-1', isSubAgent: true, parentChatId: 'chat-1', parentSource: 'web' } };
            const pending = svc.ask(sub, { question: 'Which flight?', options: ['AM 10:05', 'PM 18:40'] });
            await flush();
            const sent = agent.interface.send.mock.calls[0][0];
            expect(sent.source).toBe('web');
            expect(sent.metadata.chatId).toBe('chat-1');
            expect(db.getPendingQuestion('chat-1').chat_id).toBe('subagent-sub-1');
            await svc.intercept(reply('chat-1', '1'), jest.fn());
            await expect(pending).resolves.toEqual({ answer: 'AM 10:05' });
        });

        test('a sub-agent without a live parent gets an error and nothing is sent', async () => {
            const sub = { source: 'subagent', metadata: { chatId: 'subagent-sub-1', isSubAgent: true, parentChatId: 'job-1', parentSource: 'scheduler' } };
            await expect(svc.ask(sub, { question: 'Code?' })).resolves.toEqual({ error: 'askUser unavailable; report what you need to the parent' });
            expect(agent.interface.send).not.toHaveBeenCalled();
            expect(db.getPendingQuestion('job-1')).toBeUndefined();
        });

        test('a sub-agent message never counts as an answer', async () => {
            const pending = svc.ask(webMsg('chat-1'), { question: 'Code?' });
            await flush();
            const subMsg = { role: 'user', content: '1234', source: 'subagent', metadata: { chatId: 'chat-1', isSubAgent: true } };
            expect(await svc.intercept(subMsg, jest.fn())).toBeNull();
            svc.cancelAll();
            await pending;
        });
    });

    describe('timeout', () => {
        test('defaults to 300 s, caps at 900 s, floors at 5 s', () => {
            expect(clampTimeoutSeconds(undefined)).toBe(300);
            expect(clampTimeoutSeconds('abc')).toBe(300);
            expect(clampTimeoutSeconds(0)).toBe(300);
            expect(clampTimeoutSeconds(100000)).toBe(900);
            expect(clampTimeoutSeconds(1)).toBe(5);
            expect(clampTimeoutSeconds(120)).toBe(120);
        });

        test('resolves { timeout: true }, marks the row, and answers a late reply once', async () => {
            const start = Date.now();
            const pending = svc.ask(webMsg('chat-1'), { question: 'Code?', timeoutSeconds: 10 });
            await flush();
            const row = db.getPendingQuestion('chat-1');
            expect(new Date(row.expires_at).getTime() - start).toBeGreaterThanOrEqual(10_000);

            jest.advanceTimersByTime(9_000);
            expect(svc.hasPending('chat-1')).toBe(true);
            jest.advanceTimersByTime(1_000);
            await expect(pending).resolves.toEqual({ timeout: true });
            expect(db.db.prepare('SELECT status FROM pending_questions WHERE id = ?').get(row.id).status).toBe('timeout');

            const cb = jest.fn().mockResolvedValue();
            const late = await svc.intercept(reply('chat-1', '1234'), cb);
            expect(late.content).toBe('That question expired.');
            expect(cb).toHaveBeenCalledWith(late);
            // The next message is a normal message again
            expect(await svc.intercept(reply('chat-1', 'hello'), cb)).toBeNull();
        });

        test('a new request after the expiry runs as usual; only an answer-like reply is swallowed', async () => {
            const cb = jest.fn().mockResolvedValue();
            const pending = svc.ask(webMsg('chat-1'), { question: 'Code?', timeoutSeconds: 5 });
            await flush();
            jest.advanceTimersByTime(5_000);
            await pending;
            // A sentence is a new request, not a late code.
            expect(await svc.intercept(reply('chat-1', 'what is on my calendar today?'), cb)).toBeNull();
            expect(cb).not.toHaveBeenCalled();
            // The note is spent: even a code-like message now runs as usual.
            expect(await svc.intercept(reply('chat-1', '1234'), cb)).toBeNull();

            const withOptions = svc.ask(webMsg('chat-2'), { question: 'Book it?', options: ['Yes', 'No'], timeoutSeconds: 5 });
            await flush();
            jest.advanceTimersByTime(5_000);
            await withOptions;
            const late = await svc.intercept(reply('chat-2', 'no'), cb);
            expect(late.content).toBe('That question expired.');

            const byNumber = svc.ask(webMsg('chat-3'), { question: 'Book it?', options: ['Yes', 'No'], timeoutSeconds: 5 });
            await flush();
            jest.advanceTimersByTime(5_000);
            await byNumber;
            expect((await svc.intercept(reply('chat-3', '2'), cb)).content).toBe('That question expired.');

            const moved = svc.ask(webMsg('chat-4'), { question: 'Book it?', options: ['Yes', 'No'], timeoutSeconds: 5 });
            await flush();
            jest.advanceTimersByTime(5_000);
            await moved;
            // A short token that is not an option is a new message when options exist.
            expect(await svc.intercept(reply('chat-4', 'status'), cb)).toBeNull();
        });

        test('looksLikeLateAnswer', () => {
            expect(looksLikeLateAnswer('1234', [])).toBe(true);
            expect(looksLikeLateAnswer('123456', [])).toBe(true);
            expect(looksLikeLateAnswer('12345678', [])).toBe(true);
            // Without options only a bare 4-8 digit code counts; words reach the model.
            expect(looksLikeLateAnswer('123', [])).toBe(false);
            expect(looksLikeLateAnswer('123456789', [])).toBe(false);
            expect(looksLikeLateAnswer('yes', [])).toBe(false);
            expect(looksLikeLateAnswer('ok', [])).toBe(false);
            expect(looksLikeLateAnswer('hola', [])).toBe(false);
            expect(looksLikeLateAnswer('luces', [])).toBe(false);
            expect(looksLikeLateAnswer('what is on my calendar today?', [])).toBe(false);
            expect(looksLikeLateAnswer('averyveryverylongtoken', [])).toBe(false);
            expect(looksLikeLateAnswer('1', ['A', 'B'])).toBe(true);
            expect(looksLikeLateAnswer('3', ['A', 'B'])).toBe(false);
            expect(looksLikeLateAnswer('b', ['A', 'B'])).toBe(true);
            expect(looksLikeLateAnswer('ok', ['A', 'B'])).toBe(false);
        });

        test('a one-word message after an expired free-text question reaches the model', async () => {
            const cb = jest.fn().mockResolvedValue();
            for (const word of ['hola', 'ok', 'luces']) {
                const chatId = `chat-${word}`;
                const pending = svc.ask(webMsg(chatId), { question: 'Code?', timeoutSeconds: 5 });
                await flush();
                jest.advanceTimersByTime(5_000);
                await pending;
                expect(await svc.intercept(reply(chatId, word), cb)).toBeNull();
            }
            expect(cb).not.toHaveBeenCalled();
        });

        test('a code more than 120 s after the expiry is a normal message', async () => {
            const pending = svc.ask(webMsg('chat-1'), { question: 'Code?', timeoutSeconds: 5 });
            await flush();
            jest.advanceTimersByTime(5_000);
            await pending;
            jest.setSystemTime(Date.now() + 121 * 1000);
            expect(await svc.intercept(reply('chat-1', '1234'), jest.fn())).toBeNull();
        });

        test('a code within 120 s of the expiry is told the question expired', async () => {
            const pending = svc.ask(webMsg('chat-1'), { question: 'Code?', timeoutSeconds: 5 });
            await flush();
            jest.advanceTimersByTime(5_000);
            await pending;
            jest.setSystemTime(Date.now() + 119 * 1000);
            expect((await svc.intercept(reply('chat-1', '1234'), jest.fn())).content).toBe('That question expired.');
        });
    });

    describe('cancel', () => {
        test('/stop in the chat rejects the wait and is not swallowed', async () => {
            const pending = svc.ask(webMsg('chat-1'), { question: 'Code?' });
            await flush();
            expect(await svc.intercept(reply('chat-1', '/stop'), jest.fn())).toBeNull();
            await expect(pending).resolves.toEqual({ cancelled: true });
            expect(db.db.prepare("SELECT status FROM pending_questions WHERE reply_chat_id = 'chat-1'").get().status).toBe('cancelled');
        });

        test('/cancel typed in the origin chat ends a question that went to the owner', async () => {
            const pending = svc.ask({ source: 'scheduler', metadata: { chatId: 'job-1' } }, { question: 'Code?' });
            await flush();
            expect(await svc.intercept(reply('job-1', '/cancel'), jest.fn())).toBeNull();
            await expect(pending).resolves.toEqual({ cancelled: true });
        });

        test('a stop flag or the web Stop button ends the wait within a second', async () => {
            const p1 = svc.ask(webMsg('chat-1'), { question: 'Code?' });
            await flush();
            agent.stopFlags.add('GLOBAL_STOP');
            jest.advanceTimersByTime(1_000);
            await expect(p1).resolves.toEqual({ cancelled: true });
            agent.stopFlags.clear();

            const p2 = svc.ask(webMsg('chat-2'), { question: 'Code?' });
            await flush();
            agent.cancellationFlags.add('chat-2');
            jest.advanceTimersByTime(1_000);
            await expect(p2).resolves.toEqual({ cancelled: true });
        });

        test('cancelAll ends every wait', async () => {
            const a = svc.ask(webMsg('chat-1'), { question: 'A?' });
            const b = svc.ask(webMsg('chat-2'), { question: 'B?' });
            await flush();
            svc.cancelAll();
            await expect(a).resolves.toEqual({ cancelled: true });
            await expect(b).resolves.toEqual({ cancelled: true });
            expect(svc.waits.size).toBe(0);
        });
    });

    describe('expire on boot', () => {
        test('pending rows from a previous run become expired and a prompt late reply is told so', async () => {
            db.createPendingQuestion({ id: 'q-old', chatId: 'chat-1', replyChatId: 'chat-1', replySource: 'web', source: 'web', question: 'Old?', options: [], expiresAt: null });
            db.createPendingQuestion({ id: 'q-opt', chatId: 'chat-2', replyChatId: 'chat-2', replySource: 'web', source: 'web', question: 'Pick?', options: ['Red', 'Blue'], expiresAt: null });
            db.createPendingQuestion({ id: 'q-done', chatId: 'chat-3', replyChatId: 'chat-3', replySource: 'web', source: 'web', question: 'Done?', options: [] });
            db.closePendingQuestion('q-done', 'answered', 'yes');

            const fresh = new AskUserService(agent);
            expect(fresh.expireOnBoot()).toBe(2);
            expect(db.db.prepare('SELECT status FROM pending_questions WHERE id = ?').get('q-old').status).toBe('expired');
            expect(db.db.prepare('SELECT status FROM pending_questions WHERE id = ?').get('q-done').status).toBe('answered');
            expect(db.getPendingQuestion('chat-1')).toBeUndefined();

            const late = await fresh.intercept(reply('chat-1', '1234'), jest.fn());
            expect(late.content).toBe('That question expired.');
            // Options survive the restart, so "blue" reads as a late answer and a request does not.
            expect(fresh.recentlyClosed.get('chat-2').options).toEqual(['Red', 'Blue']);
            expect(await fresh.intercept(reply('chat-2', 'show me the weather'), jest.fn())).toBeNull();
            expect(fresh.expireOnBoot()).toBe(0);
        });
    });
});
