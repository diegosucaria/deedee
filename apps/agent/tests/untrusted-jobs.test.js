/**
 * No taint laundering: a job, task, reminder or watcher created by a run
 * that read untrusted content stores that taint, and every later run of it
 * starts tainted, so its outward actions still ask the owner.
 */
const fs = require('fs');
const path = require('path');
const { SchedulerExecutor } = require('../src/executors/scheduler');
const { CommunicationExecutor } = require('../src/executors/communication');
const { Scheduler } = require('../src/scheduler');
const { AgentDB } = require('../src/db');

const OWNER_DIGITS = '10000000000';
const CONTACT_JID = '5490000000000@s.whatsapp.net';
const MAIL = ['email (personal_gmail)'];

function fakeAgent() {
    return {
        db: {
            getAllAgentSettings: () => ({ owner_phone: `+${OWNER_DIGITS}`, notification_channel: 'whatsapp' }),
            saveScheduledJob: jest.fn(),
            getScheduledJobs: jest.fn().mockReturnValue([]),
            deleteScheduledJob: jest.fn(),
            deleteJobState: jest.fn(),
            logJobExecution: jest.fn(),
        },
        settings: {},
        interface: { send: jest.fn().mockResolvedValue(true), broadcast: jest.fn().mockResolvedValue(true) },
        processMessage: jest.fn().mockResolvedValue({}),
    };
}

describe('jobs created by a tainted run', () => {
    let agent;
    let scheduler;
    let captured;
    let executor;
    let logSpy;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        agent = fakeAgent();
        scheduler = new Scheduler(agent);
        captured = {};
        // Capture instead of arming node-schedule timers.
        scheduler.scheduleJob = jest.fn((name, rule, callback, options) => { captured[name] = { rule, callback, options }; });
        executor = new SchedulerExecutor({ scheduler, db: agent.db, agent });
    });

    afterEach(() => logSpy.mockRestore());

    const ctx = (taint, message = { source: 'web', metadata: { chatId: 'web-chat-1' } }) => ({
        message, untrustedTaint: taint, processMessage: agent.processMessage,
    });

    test('scheduleJob stores the taint, and the job run starts tainted', async () => {
        await executor.execute('scheduleJob', { name: 'followup', cron: '0 9 * * *', task: 'check the bill' }, ctx(MAIL));
        const job = captured.followup;
        expect(job.options.payload).toMatchObject({ task: 'check the bill', tainted: true, taintSources: MAIL });
        await job.callback();
        const msg = agent.processMessage.mock.calls[0][0];
        expect(msg.metadata.untrustedTaint).toEqual(['email (personal_gmail) [carried by job "followup"]']);
        expect(msg.metadata.jobName).toBe('followup');
    });

    test('after a restart the stored job still starts tainted', async () => {
        agent.db.getScheduledJobs.mockReturnValue([{
            name: 'followup', cronExpression: '0 9 * * *', taskType: 'agent_instruction', enabled: true,
            payload: { task: 'check the bill', targetChatId: null, targetSource: null, tainted: true, taintSources: MAIL },
        }]);
        await scheduler.loadJobs();
        await captured.followup.callback();
        const msg = agent.processMessage.mock.calls[0][0];
        expect(msg.metadata.untrustedTaint).toEqual(['email (personal_gmail) [carried by job "followup"]']);
    });

    test('a retry keeps the taint', async () => {
        agent.processMessage.mockRejectedValueOnce(new Error('model down'));
        const cb = scheduler._buildAgentInstructionCallback('task_1', { task: 'x', isOneOff: true, retryCount: 0, tainted: true, taintSources: MAIL });
        await expect(cb()).rejects.toThrow('model down');
        expect(captured.task_1.options.payload).toMatchObject({ retryCount: 1, tainted: true, taintSources: MAIL });
    });

    test('scheduleTask stores the taint; its run starts tainted', async () => {
        const when = new Date(Date.now() + 3600e3).toISOString();
        await executor.execute('scheduleTask', { time: when, task: 'send the report' }, ctx(MAIL));
        const [name] = Object.keys(captured);
        expect(captured[name].options.payload).toMatchObject({ tainted: true, taintSources: MAIL });
        await captured[name].callback();
        expect(agent.processMessage.mock.calls[0][0].metadata.untrustedTaint).toEqual([`email (personal_gmail) [carried by job "${name}"]`]);
    });

    test('setReminder stores the taint and keeps delivering to the owner', async () => {
        const when = new Date(Date.now() + 3600e3).toISOString();
        await executor.execute('setReminder', { time: when, message: 'pay the bill' }, ctx(MAIL));
        const [name] = Object.keys(captured);
        expect(captured[name].options.payload).toMatchObject({ isReminder: true, tainted: true, targetChatId: 'web-chat-1' });
    });

    test('a tainted run in a contact chat never points its job or reminder at that chat', async () => {
        const when = new Date(Date.now() + 3600e3).toISOString();
        const contactMsg = { source: 'whatsapp', metadata: { chatId: CONTACT_JID } };
        await executor.execute('setReminder', { time: when, message: 'x' }, ctx(MAIL, contactMsg));
        await executor.execute('scheduleJob', { name: 'j', cron: '0 9 * * *', task: 'x' }, ctx(MAIL, contactMsg));
        for (const { options } of Object.values(captured)) {
            expect(options.payload.targetChatId).toBeUndefined();
            expect(options.payload.tainted).toBe(true);
        }
        // The owner's own WhatsApp chat keeps its target.
        captured = {};
        await executor.execute('scheduleJob', { name: 'k', cron: '0 9 * * *', task: 'x' }, ctx(MAIL, { source: 'whatsapp', metadata: { chatId: `${OWNER_DIGITS}@s.whatsapp.net` } }));
        expect(captured.k.options.payload.targetChatId).toBe(`${OWNER_DIGITS}@s.whatsapp.net`);
    });

    test('a clean owner request creates a clean job', async () => {
        await executor.execute('scheduleJob', { name: 'clean', cron: '0 9 * * *', task: 'weather' }, ctx([]));
        expect(captured.clean.options.payload.tainted).toBeUndefined();
        expect(captured.clean.options.payload.targetChatId).toBe('web-chat-1');
        await captured.clean.callback();
        expect(agent.processMessage.mock.calls[0][0].metadata.untrustedTaint).toBeUndefined();
    });
});

describe('watchers created by a tainted run', () => {
    let tmpDir;
    let db;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(__dirname, 'tmp-untrusted-watchers-'));
        db = new AgentDB(tmpDir);
    });

    afterAll(() => {
        try { db.close?.(); } catch { /* ignore */ }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('addWatcher stores the sources on the row; a clean one stores none', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });
        const executor = new CommunicationExecutor({ db });
        await executor.execute('addWatcher', { contactString: '5490000000000', condition: 'contains "x"', instruction: 'Tell me' }, { message: {}, untrustedTaint: MAIL });
        await executor.execute('addWatcher', { contactString: '5490000000001', condition: 'contains "y"', instruction: 'Tell me' }, { message: {}, untrustedTaint: [] });
        const rows = db.getWatchers('active');
        logSpy.mockRestore();
        expect(JSON.parse(rows.find(r => r.contact_string === '5490000000000').taint_sources)).toEqual(MAIL);
        expect(rows.find(r => r.contact_string === '5490000000001').taint_sources).toBeNull();
    });
});
