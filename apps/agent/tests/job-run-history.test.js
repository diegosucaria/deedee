/**
 * Job History links each run to its messages, and prices the run from them.
 *
 * A job log row is written when the run ENDS. The cost match used to count
 * from the row's time forward, so it caught the last call of a run at most:
 * on the device, 40 runs showed $0.15 where they had cost $1.52.
 */
const { AgentDB } = require('../src/db');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('a job log finds its run', () => {
    let db, dir;
    const END = Date.parse('2026-09-21T10:05:00Z');
    const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

    /** A log row as the scheduler writes it: stamped at the end of the run. */
    const logRun = (name, { endMs = END, durationMs = 60000, status = 'success' } = {}) => {
        const info = db.db.prepare('INSERT INTO job_logs (job_name, status, output, duration_ms, timestamp) VALUES (?, ?, ?, ?, ?)')
            .run(name, status, 'done', durationMs, sqlTime(endMs));
        return db.db.prepare('SELECT * FROM job_logs WHERE id = ?').get(info.lastInsertRowid);
    };
    const say = (chatId, atMs, text = 'step') => db.saveMessage({ role: 'model', content: text, chatId, source: 'scheduler', timestamp: atMs });
    const spend = (chatId, cost, atMs) => {
        db.logTokenUsage({ model: 'm', promptTokens: 10, candidateTokens: 5, totalTokens: 15, chatId, estimatedCost: cost });
        db.db.prepare('UPDATE token_usage SET timestamp = ? WHERE id = (SELECT MAX(id) FROM token_usage)').run(sqlTime(atMs));
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deedee-jobrun-'));
        db = new AgentDB(dir);
    });
    afterEach(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('getJobRunHistory', () => {
        test('a user job: the chat that began inside the run', () => {
            const start = END - 60000;
            say(`scheduled_morning_briefing_${start + 40}`, start + 100);
            expect(db.getJobRunHistory(logRun('morning_briefing'))).toEqual({ chatId: `scheduled_morning_briefing_${start + 40}` });
        });

        test('a system job: the system_ chat, even when it began late in the run (the proactive delay)', () => {
            const start = END - 30 * 60000;
            say(`system_proactive_thought_${start + 25 * 60000}`, start + 25 * 60000 + 50);
            expect(db.getJobRunHistory(logRun('proactive_thought', { durationMs: 30 * 60000 })))
                .toEqual({ chatId: `system_proactive_thought_${start + 25 * 60000}` });
        });

        test('yesterday\'s run of the same job is not this run', () => {
            say(`scheduled_morning_briefing_${END - 24 * 3600000 - 50000}`, END - 24 * 3600000);
            expect(db.getJobRunHistory(logRun('morning_briefing'))).toBeNull();
        });

        test('each of two runs gets its own chat', () => {
            const first = END - 3600000;
            say(`scheduled_hourly_${first - 20000}`, first - 19000);
            say(`scheduled_hourly_${END - 20000}`, END - 19000);
            expect(db.getJobRunHistory(logRun('hourly', { endMs: first, durationMs: 21000 }))).toEqual({ chatId: `scheduled_hourly_${first - 20000}` });
            expect(db.getJobRunHistory(logRun('hourly', { durationMs: 21000 }))).toEqual({ chatId: `scheduled_hourly_${END - 20000}` });
        });

        test('a job whose name starts another job\'s name never takes its chat', () => {
            say(`scheduled_check_mail_${END - 30000}`, END - 29000);
            expect(db.getJobRunHistory(logRun('check'))).toBeNull();
            say(`scheduled_check_1_${END - 30000}`, END - 29000);
            expect(db.getJobRunHistory(logRun('check'))).toBeNull();
            expect(db.getJobRunHistory(logRun('check_mail'))).toEqual({ chatId: `scheduled_check_mail_${END - 30000}` });
        });

        test('a job that ran no model has no history', () => {
            expect(db.getJobRunHistory(logRun('nightly_backup', { durationMs: 97000 }))).toBeNull();
        });

        test('a job that reports into a chat of its own: that chat, from the moment the run began', () => {
            db.saveScheduledJob({ name: 'standup_nudge', cronExpression: '0 9 * * 1-5', taskType: 'agent_instruction', payload: { task: 'x', targetChatId: '100000000000001@g.us' } });
            say('100000000000001@g.us', END - 86400000, 'an older message');
            expect(db.getJobRunHistory(logRun('standup_nudge'))).toBeNull();

            say('100000000000001@g.us', END - 30000, 'the run');
            const hit = db.getJobRunHistory(logRun('standup_nudge'));
            expect(hit.chatId).toBe('100000000000001@g.us');
            expect(Date.parse(hit.since)).toBe(END - 60000 - 2000);
        });

        test('a row with no usable time, or no name, has no history', () => {
            expect(db.getJobRunHistory({ job_name: 'x', timestamp: 'not a date', duration_ms: 10 })).toBeNull();
            expect(db.getJobRunHistory({ job_name: '', timestamp: sqlTime(END), duration_ms: 10 })).toBeNull();
            expect(db.getJobRunHistory(null)).toBeNull();
        });
    });

    describe('getJobRunCost', () => {
        test('counts the whole run, and the sub-agents it spawned', () => {
            const start = END - 76000;
            const chat = `scheduled_morning_briefing_${start + 30}`;
            say(chat, start + 100);
            spend(chat, 0.10, start + 5000);
            spend(chat, 0.05, start + 40000);
            spend(chat, 0.01, END - 1000);
            db.createSubAgent({ id: 'sa1', parentChatId: chat, task: 't', model: 'FLASH' });
            spend('subagent-sa1', 0.04, start + 20000);
            // Someone else's spend, and another run's.
            spend('web-chat-1', 0.50, start + 10000);
            spend(`scheduled_morning_briefing_${start - 86400000}`, 0.30, start - 86400000 + 1000);

            const cost = db.getJobRunCost(logRun('morning_briefing', { durationMs: 76000 }).id);
            expect(cost.totalCost).toBeCloseTo(0.20, 6);
            expect(cost.callCount).toBe(4);
        });

        test('with the run\'s messages gone, the match is by name and time, counted back from the end', () => {
            const start = END - 60000;
            spend(`scheduled_weekly_${start + 10}`, 0.07, start + 2000);
            spend(`scheduled_weekly_${start + 10}`, 0.02, END - 3000);
            // After the run ended: the old match counted this and missed the two above.
            spend(`scheduled_weekly_${END + 20000}`, 0.90, END + 30000);

            const cost = db.getJobRunCost(logRun('weekly').id);
            expect(cost.totalCost).toBeCloseTo(0.09, 6);
            expect(cost.callCount).toBe(2);
        });

        test('a job that ran no model costs nothing; an unknown row costs nothing', () => {
            expect(db.getJobRunCost(logRun('nightly_backup').id)).toEqual({ totalCost: 0, totalTokens: 0, callCount: 0 });
            expect(db.getJobRunCost(99999)).toEqual({ totalCost: 0, totalTokens: 0, callCount: 0 });
        });
    });
});
