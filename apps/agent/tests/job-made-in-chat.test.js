/**
 * A job made in a chat stays quiet when a run has nothing to say.
 *
 * 2026-09: a job made in the owner's web chat was extended from WhatsApp.
 * The model cancelled it and made it again, so the new job belonged to the
 * WhatsApp chat. A job made in a chat ran inside that chat and sent every
 * reply straight out, so each run sent the owner "[SILENT] No earlier slots
 * found ...". Real SQLite, the real scheduler, executor, Tasks route and
 * delivery ledger; a scripted model.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { AgentDB } = require('../src/db');
const { Scheduler } = require('../src/scheduler');
const { SchedulerExecutor } = require('../src/executors/scheduler');
const { ApprovalService } = require('../src/services/approval-service');
const { createInternalRouter } = require('../src/routes/internal');

const OWNER_DIGITS = '10000000000';
const OWNER_JID = `${OWNER_DIGITS}@s.whatsapp.net`;
const OWNER_LID = '200000000000002@lid';
const CRON = '0 7,11,13 * * 1-5';
const TASK = "Use my_appointments to find the appointment on Oct 1. Then use find_earlier for it. If there is an earlier slot, use sendMessage to 'me'. Do NOT book it.";
const SCOPED = ['my_appointments', 'find_earlier', 'sendMessage', 'getJobState', 'saveJobState'];

function makeAgent(db) {
    return {
        db,
        settings: {},
        interface: { send: jest.fn().mockResolvedValue(true), broadcast: jest.fn().mockResolvedValue(true) },
        notifications: { create: jest.fn() },
        toolScoper: { scope: jest.fn().mockResolvedValue(SCOPED) },
        mcp: { getTools: jest.fn().mockResolvedValue([]) },
        processMessage: jest.fn()
    };
}

// The model: a progress line while a tool runs, then its final answer.
// `isError` marks the agent's own error reply, as agent.js does.
function scriptRun(agent, finalText, { isError = false } = {}) {
    const ids = [];
    agent.processMessage.mockImplementation(async (msg, send) => {
        const reply = (content) => {
            const r = { id: `reply-${ids.length + 1}`, role: 'assistant', content, source: msg.source, metadata: { chatId: msg.metadata.chatId } };
            ids.push(r.id);
            return r;
        };
        await send(reply('Thinking... (Checking your appointments...)'));
        await send(isError ? { ...reply(finalText), isError: true } : reply(finalText));
    });
    return ids;
}

// What reached a person. The interfaces service only logs a scheduler reply.
const delivered = (agent) => agent.interface.send.mock.calls.map(c => c[0]).filter(m => m.source !== 'scheduler');
const inChat = (source, chatId, taint = []) => ({ message: { source, metadata: { chatId } }, untrustedTaint: taint });
const savedPayload = (db, name) => db.getScheduledJobs().find(j => j.name === name)?.payload;

describe('a job made in a chat', () => {
    let dir, db, agent, scheduler, executor, env;

    beforeEach(() => {
        env = { ownChat: process.env.JOB_OWN_CHAT, ids: process.env.ALLOWED_TELEGRAM_IDS, phone: process.env.MY_PHONE };
        delete process.env.JOB_OWN_CHAT;
        delete process.env.ALLOWED_TELEGRAM_IDS;
        delete process.env.MY_PHONE;
        for (const level of ['log', 'warn', 'error']) jest.spyOn(console, level).mockImplementation(() => { });
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-job-chat-'));
        db = new AgentDB(dir);
        db.setAgentSetting('owner_phone', `+${OWNER_DIGITS}`);
        db.setAgentSetting('notification_channel', 'whatsapp');
        agent = makeAgent(db);
        scheduler = new Scheduler(agent);
        agent.scheduler = scheduler;
        executor = new SchedulerExecutor({ scheduler, db, agent, mcp: agent.mcp });
    });

    afterEach(async () => {
        await scheduler.stop();
        agent.delivery?.stop();
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        for (const [key, name] of [['ownChat', 'JOB_OWN_CHAT'], ['ids', 'ALLOWED_TELEGRAM_IDS'], ['phone', 'MY_PHONE']]) {
            if (env[key] === undefined) delete process.env[name]; else process.env[name] = env[key];
        }
        jest.restoreAllMocks();
    });

    test('extended from WhatsApp by a cancel and a new job, a [SILENT] run sends nothing', async () => {
        await executor.execute('scheduleJob', { name: 'check_slots', cron: CRON, task: TASK, expiresAt: '2026-09-25T23:59:00' }, inChat('web', 'web-chat-1'));
        // The owner asks on WhatsApp for one more week, and the model does what it did.
        const whatsapp = inChat('whatsapp:assistant', OWNER_LID);
        await executor.execute('cancelJob', { name: 'check_slots' }, whatsapp);
        await executor.execute('scheduleJob', {
            name: 'check_slots', cron: CRON, expiresAt: '2026-10-01T23:59:00',
            task: `${TASK} If no slots are found, prefix your ENTIRE response with [SILENT] so no message is sent.`
        }, whatsapp);
        scriptRun(agent, '[SILENT] No earlier slots found before Oct 1.');

        await scheduler.jobs.check_slots.invoke();

        expect(delivered(agent)).toEqual([]);
        expect(db.listRecentOutbox({ limit: 5 })).toEqual([]);
        const run = agent.processMessage.mock.calls[0][0];
        expect(run.source).toBe('scheduler');
        expect(run.metadata.chatId).toMatch(/^scheduled_check_slots_\d{13}$/);
        expect(run.metadata.allowedTools).toEqual(SCOPED);
        expect(run.content).toContain('prefix your ENTIRE response with the tag [SILENT]');
        // Job History keeps the run and why it stayed quiet.
        const { logs } = db.getJobLogs(5);
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0].output)).toMatchObject({ decision: 'silent', text: 'No earlier slots found before Oct 1.' });
    });

    test('a run with news answers once, in the chat the job was made in, with no progress lines', async () => {
        await executor.execute('scheduleJob', { name: 'check_slots', cron: CRON, task: TASK }, inChat('whatsapp:assistant', OWNER_LID));
        scriptRun(agent, 'Earlier slot: Sep 30 at 10:00.');

        await scheduler.jobs.check_slots.invoke();

        expect(delivered(agent)).toEqual([expect.objectContaining({
            source: 'whatsapp', content: 'Earlier slot: Sep 30 at 10:00.', metadata: { chatId: OWNER_LID, session: 'assistant' }
        })]);
        expect(db.listRecentOutbox({ limit: 5 })).toEqual([expect.objectContaining({ kind: 'job_notification', target: OWNER_LID, status: 'sent' })]);
    });

    test('a result that starts with ⚠️ still goes out; the agent\'s own error reply does not', async () => {
        await executor.execute('scheduleJob', { name: 'weather', cron: '0 7 * * *', task: 'Check the weather' }, inChat('whatsapp:assistant', OWNER_LID));
        scriptRun(agent, '⚠️ Storm warning after 3 pm.');
        await scheduler.jobs.weather.invoke();
        expect(delivered(agent)).toEqual([expect.objectContaining({ content: '⚠️ Storm warning after 3 pm.' })]);

        agent.interface.send.mockClear();
        scriptRun(agent, '⚠️ The AI model is currently experiencing high demand. Please try again in a moment.', { isError: true });
        await scheduler.jobs.weather.invoke();
        expect(delivered(agent)).toEqual([]);
    });

    test('after a restart the job is still quiet on a [SILENT] run', async () => {
        await executor.execute('scheduleJob', { name: 'check_slots', cron: CRON, task: TASK }, inChat('whatsapp:assistant', OWNER_LID));
        await scheduler.stop();
        scheduler = new Scheduler(agent);
        await scheduler.loadJobs();
        scriptRun(agent, '  **[SILENT]** Nothing earlier.');

        await scheduler.jobs.check_slots.invoke();

        expect(delivered(agent)).toEqual([]);
        expect(agent.processMessage.mock.calls[0][0]).toMatchObject({ source: 'scheduler', metadata: { jobOrigin: { source: 'whatsapp:assistant', chatId: OWNER_LID } } });
    });

    test('a job made in the web chat reports to the owner channel, and its approval card still shows in that chat', async () => {
        await executor.execute('scheduleJob', { name: 'check_slots', cron: CRON, task: TASK }, inChat('web', 'web-chat-1'));
        scriptRun(agent, 'Earlier slot: Sep 30 at 10:00.');

        await scheduler.jobs.check_slots.invoke();

        expect(delivered(agent)).toEqual([expect.objectContaining({ source: 'whatsapp', metadata: { chatId: OWNER_JID, session: 'assistant' } })]);
        const run = agent.processMessage.mock.calls[0][0];
        const approvals = new ApprovalService({ ...agent, delivery: scheduler._delivery() });
        expect(await approvals.route(run)).toMatchObject({ replyChatId: OWNER_JID, mode: 'deferred', mirror: { channel: 'web', chatId: 'web-chat-1' } });
        approvals.stop();
    });

    test('scheduleJob with the same name changes the job in place: its chat, saved state and end date stay', async () => {
        await executor.execute('scheduleJob', { name: 'check_slots', cron: CRON, task: TASK, expiresAt: '2026-10-01T23:59:00' }, inChat('web', 'web-chat-1'));
        db.setKey('job:check_slots:seen', ['2026-09-30 10:00']);

        const res = await executor.execute('scheduleJob', { name: 'check_slots', cron: '0 9 * * 1-5', task: TASK }, inChat('whatsapp:assistant', OWNER_LID));

        expect(res.success).toBe(true);
        expect(savedPayload(db, 'check_slots')).toMatchObject({ targetSource: 'web', targetChatId: 'web-chat-1', allowedTools: SCOPED });
        expect(scheduler.jobs.check_slots.metadata).toMatchObject({ cronExpression: '0 9 * * 1-5', expiresAt: '2026-10-01T23:59:00' });
        expect(db.getJobState('check_slots')).toEqual([expect.objectContaining({ key: 'seen' })]);
        // The same task keeps its tool list; a new task gets a new one.
        expect(agent.toolScoper.scope).toHaveBeenCalledTimes(1);
        await executor.execute('scheduleJob', { name: 'check_slots', cron: CRON, task: 'Something else' }, inChat('web', 'web-chat-1'));
        expect(agent.toolScoper.scope).toHaveBeenCalledTimes(2);
    });

    test('a change from a run that read untrusted content never points the job at a contact chat', async () => {
        await executor.execute('scheduleJob', { name: 'standup', cron: '0 9 * * 1-5', task: 'Post the standup reminder' }, inChat('slack', 'C0EXAMPLE1'));
        expect(savedPayload(db, 'standup')).toMatchObject({ targetSource: 'slack', targetChatId: 'C0EXAMPLE1' });

        await executor.execute('scheduleJob', { name: 'standup', cron: '0 9 * * 1-5', task: 'Post the standup reminder' },
            inChat('whatsapp:assistant', OWNER_LID, ['email (personal_gmail)']));

        const payload = savedPayload(db, 'standup');
        expect(payload.targetChatId).toBeUndefined();
        expect(payload).toMatchObject({ tainted: true, taintSources: ['email (personal_gmail)'] });
    });

    test('scheduleJob cannot overwrite a built-in job', async () => {
        scheduler.scheduleJob('proactive_thought', '0 7-22 * * *', async () => { }, { payload: { task: 'x', isSystem: true } });

        const res = await executor.execute('scheduleJob', { name: 'proactive_thought', cron: '* * * * *', task: 'spam' }, inChat('web', 'web-chat-1'));

        expect(res.error).toMatch(/built-in job/);
        expect(scheduler.jobs.proactive_thought.metadata).toMatchObject({ cronExpression: '0 7-22 * * *', payload: { task: 'x', isSystem: true } });
    });

    test('a repeating job that fails keeps its schedule', async () => {
        await executor.execute('scheduleJob', { name: 'check_slots', cron: CRON, task: TASK }, inChat('whatsapp:assistant', OWNER_LID));
        agent.processMessage.mockRejectedValue(new Error('model down'));

        await scheduler.jobs.check_slots.invoke();

        expect(scheduler.jobs.check_slots.metadata).toMatchObject({ cronExpression: CRON });
        expect(scheduler.jobs.check_slots.metadata.payload.isOneOff).toBeFalsy();
        expect(db.getScheduledJobs().find(j => j.name === 'check_slots')).toMatchObject({ cronExpression: CRON });
        expect(db.getJobLogs(5).logs[0]).toMatchObject({ status: 'failure', output: 'model down' });
    });

    test('JOB_OWN_CHAT=0 runs it inside its chat, and still sends only a final reply that is not [SILENT]', async () => {
        process.env.JOB_OWN_CHAT = '0';
        await executor.execute('scheduleJob', { name: 'check_slots', cron: CRON, task: TASK }, inChat('whatsapp:assistant', OWNER_LID));
        scriptRun(agent, '[SILENT] Nothing earlier.');

        await scheduler.jobs.check_slots.invoke();

        expect(agent.processMessage.mock.calls[0][0]).toMatchObject({ source: 'whatsapp:assistant', metadata: { chatId: OWNER_LID } });
        expect(agent.interface.send).not.toHaveBeenCalled();

        const ids = scriptRun(agent, 'Earlier slot: Sep 30 at 10:00.');
        await scheduler.jobs.check_slots.invoke();

        // One message, under the id the run saved it with, so the thread keeps one copy.
        expect(delivered(agent)).toEqual([expect.objectContaining({ id: ids[1], content: 'Earlier slot: Sep 30 at 10:00.', metadata: { chatId: OWNER_LID, session: 'assistant' } })]);
    });

    describe('saved from the Tasks form', () => {
        const app = () => {
            const a = express();
            a.use(express.json());
            a.use('/internal', createInternalRouter(agent));
            return a;
        };

        test('tells the owner its result from the first run, not only after a restart', async () => {
            const res = await request(app()).post('/internal/scheduler').send({ name: 'weather', cron: '0 7 * * *', task: 'Check the weather' });
            expect(res.status).toBe(200);
            scriptRun(agent, 'Rain after 3 pm.');

            await scheduler.jobs.weather.invoke();

            expect(delivered(agent)).toEqual([expect.objectContaining({ source: 'whatsapp', content: 'Rain after 3 pm.', metadata: { chatId: OWNER_JID, session: 'assistant' } })]);
            expect(agent.processMessage.mock.calls[0][0].content).toContain('[SILENT]');
        });

        test('an edit keeps the chat the job was made in', async () => {
            await executor.execute('scheduleJob', { name: 'check_slots', cron: CRON, task: TASK }, inChat('whatsapp:assistant', OWNER_LID));

            await request(app()).post('/internal/scheduler').send({ name: 'check_slots', cron: CRON, task: `${TASK} Say the time too.` });

            expect(savedPayload(db, 'check_slots')).toMatchObject({ targetSource: 'whatsapp:assistant', targetChatId: OWNER_LID });
        });
    });
});
