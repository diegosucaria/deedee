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

        test('runs of one job that overlap each get their own chat: the first one in the window', () => {
            // Every minute, three minutes each. A = 10:00 to 10:03, B = 10:01 to 10:04, C = 10:02 to 10:05.
            const at = (min) => Date.parse(`2026-09-21T10:0${min}:00Z`);
            for (const min of [0, 1, 2]) say(`scheduled_poll_${at(min) + 15}`, at(min) + 500);
            for (const min of [0, 1, 2]) {
                expect(db.getJobRunHistory(logRun('poll', { endMs: at(min + 3), durationMs: 180000 }))).toEqual({ chatId: `scheduled_poll_${at(min) + 15}` });
            }
        });

        test('two runs that began a second apart each get their own chat', () => {
            // The two seconds of slack under a run's start would reach the earlier run's chat.
            const a = END - 60000;
            const b = a + 1000;
            say(`scheduled_dup_${a + 5}`, a + 100);
            say(`scheduled_dup_${b + 5}`, b + 100);
            expect(db.getJobRunHistory(logRun('dup', { endMs: a + 30000, durationMs: 30000 }))).toEqual({ chatId: `scheduled_dup_${a + 5}` });
            expect(db.getJobRunHistory(logRun('dup', { endMs: b + 30000, durationMs: 30000 }))).toEqual({ chatId: `scheduled_dup_${b + 5}` });
        });

        test('a chat stamped just under the run\'s start is still found when it is the only one (clocks that disagree)', () => {
            const start = END - 60000;
            say(`scheduled_skew_${start - 900}`, start);
            expect(db.getJobRunHistory(logRun('skew'))).toEqual({ chatId: `scheduled_skew_${start - 900}` });
        });

        test('a chat id that only looks like this job\'s is passed over, and the real one behind it is found', () => {
            const start = END - 60000;
            say(`scheduled_check_${start + 5}_of_another_job`, start + 100);
            expect(db.getJobRunHistory(logRun('check'))).toBeNull();
            say(`scheduled_check_${start + 900}`, start + 1000);
            expect(db.getJobRunHistory(logRun('check'))).toEqual({ chatId: `scheduled_check_${start + 900}` });
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
            // Both ends: without the second, an old run opens on today's messages.
            expect(Date.parse(hit.until)).toBe(END + 1000);
        });

        test('a row with no usable time, or no name, has no history', () => {
            expect(db.getJobRunHistory({ job_name: 'x', timestamp: 'not a date', duration_ms: 10 })).toBeNull();
            expect(db.getJobRunHistory({ job_name: '', timestamp: sqlTime(END), duration_ms: 10 })).toBeNull();
            expect(db.getJobRunHistory(null)).toBeNull();
        });
    });

    describe('the history a link opens', () => {
        test('order=asc in lowercase, as the page sends it, reads oldest first', () => {
            say('c-order', END - 3000, 'first');
            say('c-order', END - 2000, 'second');
            say('c-order', END - 1000, 'third');
            expect(db.getHistory({ chatId: 'c-order', order: 'asc' }).map(r => r.content)).toEqual(['first', 'second', 'third']);
            expect(db.getHistory({ chatId: 'c-order', order: 'ASC' }).map(r => r.content)).toEqual(['first', 'second', 'third']);
            expect(db.getHistory({ chatId: 'c-order' }).map(r => r.content)).toEqual(['third', 'second', 'first']);
        });

        test('since and until fence an old run off from today\'s messages', () => {
            say('c-busy', END - 30000, 'the run');
            for (let i = 0; i < 5; i++) say('c-busy', END + 86400000 + i, `today ${i}`);
            const rows = db.getHistory({ chatId: 'c-busy', since: new Date(END - 62000).toISOString(), until: new Date(END + 1000).toISOString(), order: 'asc' });
            expect(rows.map(r => r.content)).toEqual(['the run']);
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

        test('sub-agents of sub-agents count too', () => {
            const start = END - 60000;
            const chat = `scheduled_research_${start + 10}`;
            say(chat, start + 100);
            spend(chat, 0.06, start + 1000);
            db.createSubAgent({ id: 'top', parentChatId: chat, task: 't', model: 'FLASH' });
            db.createSubAgent({ id: 'mid', parentChatId: 'subagent-top', task: 't', model: 'FLASH' });
            db.createSubAgent({ id: 'leaf', parentChatId: 'subagent-mid', task: 't', model: 'FLASH' });
            spend('subagent-top', 0.10, start + 5000);
            spend('subagent-mid', 0.10, start + 9000);
            spend('subagent-leaf', 0.10, start + 12000);
            expect(db.getJobRunCost(logRun('research').id).totalCost).toBeCloseTo(0.36, 6);
        });

        test('a job that reports into one of the owner\'s chats is priced from that chat, inside the run only', () => {
            const start = END - 60000;
            const chat = '100000000000001@g.us';
            db.saveScheduledJob({ name: 'standup_nudge', cronExpression: '0 9 * * 1-5', taskType: 'agent_instruction', payload: { task: 'x', targetChatId: chat } });
            say(chat, start + 500, 'the run');
            spend(chat, 0.30, start + 2000);
            spend(chat, 0.12, END - 4000);
            // The owner's own turns in that chat, before and after the run.
            spend(chat, 0.80, start - 3600000);
            spend(chat, 0.70, END + 3600000);
            // A sub-agent of the run, and one from an ordinary turn an hour earlier.
            db.createSubAgent({ id: 'mine', parentChatId: chat, task: 't', model: 'FLASH', createdAt: new Date(start + 3000).toISOString() });
            db.createSubAgent({ id: 'earlier', parentChatId: chat, task: 't', model: 'FLASH', createdAt: new Date(start - 3600000).toISOString() });
            spend('subagent-mine', 0.05, start + 8000);
            spend('subagent-earlier', 0.40, start - 3500000);

            const cost = db.getJobRunCost(logRun('standup_nudge').id);
            expect(cost.totalCost).toBeCloseTo(0.47, 6);
            expect(cost.callCount).toBe(3);
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
