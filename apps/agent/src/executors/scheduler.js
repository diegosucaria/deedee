const { BaseExecutor } = require('./base');
const { taintPayloadFields } = require('../utils/untrusted-content');

/**
 * Where a job, task or reminder created in this run reports, and the taint
 * it carries. A run that read untrusted content stores its sources on the
 * job (payload.tainted, payload.taintSources), so every later run starts
 * tainted and its outward actions ask the owner. Such a job never reports
 * to a contact's chat: when the run did not come from one of the owner's
 * chats, the target is dropped and the owner channel gets the result.
 * `keep` is the target of a job being changed: it stays where it was made.
 */
function originFor(context, scheduler, keep = null) {
    const message = context?.message || {};
    let targetChatId = keep ? keep.targetChatId : message.metadata?.chatId;
    let targetSource = keep ? keep.targetSource : message.source;
    const taint = taintPayloadFields(context?.untrustedTaint);
    if (taint.tainted && targetChatId && scheduler && typeof scheduler._isOwnerOrigin === 'function'
        && !scheduler._isOwnerOrigin(targetSource, targetChatId)) {
        targetChatId = undefined;
        targetSource = undefined;
    }
    return { targetChatId, targetSource, taint };
}

// A job the model makes runs at most every 15 minutes. A run that read a
// planted page could otherwise make one that runs every second: a job run
// skips the chat rate limit, and a [SILENT] answer makes no sound. The Tasks
// form is the owner's own and has no such floor.
const MIN_JOB_MINUTES = 15;

// The aliases node-schedule reads (cron-parser's predefined set, exact case).
const CRON_ALIASES = new Set(['@yearly', '@monthly', '@weekly', '@daily', '@hourly']);

/** How many minutes of each hour a cron minute field fires on (1 to 60). */
function minutesPerHour(field) {
    let count = 0;
    for (const part of String(field).split(',')) {
        const [range, stepText] = part.split('/');
        const step = stepText ? Math.max(1, parseInt(stepText, 10) || 1) : 1;
        let span = 60;
        if (range.includes('-')) {
            const [from, to] = range.split('-').map(Number);
            if (Number.isFinite(from) && Number.isFinite(to) && to >= from) span = to - from + 1;
        } else if (range !== '*') {
            // "5" is one minute; "5/20" starts at 5 and repeats.
            span = stepText ? 60 - (Number(range) || 0) : 1;
        }
        count += Math.ceil(span / step);
    }
    return Math.min(Math.max(count, 1), 60);
}

/**
 * What is wrong with a schedule the model gave, or null. It must be one of
 * node-schedule's aliases, or five cron fields (six when the seconds field
 * is one number) whose minutes, hours and days are numbers, running at most
 * every 15 minutes. node-schedule fills fields left out ("* * * *" runs
 * every minute) and reads anything it cannot parse as a date.
 */
function tooOften(cron) {
    if (typeof cron !== 'string') return 'is not text';
    const spec = cron.trim();
    if (CRON_ALIASES.has(spec)) return null;
    let fields = spec.split(/\s+/);
    if (fields.length === 6) {
        if (!/^\d{1,2}$/.test(fields[0])) return 'repeats within a minute';
        fields = fields.slice(1);
    }
    if (fields.length !== 5) return 'does not have five fields';
    if (!/^[\d*,/-]+$/.test(fields[0]) || !/^[\d*,/-]+$/.test(fields[1]) || !/^[\d*,/?LW-]+$/.test(fields[2])) {
        return 'is not a cron schedule';
    }
    const perHour = minutesPerHour(fields[0]);
    return perHour > 60 / MIN_JOB_MINUTES ? `runs ${perHour} times an hour` : null;
}

// A name the Tasks page, the logs and the database can show.
const JOB_NAME_RE = /^[\p{L}\p{N} _.:-]{1,80}$/u;

// listJobs shows this in place of the task of a job that a run made after
// reading untrusted content, so the text cannot be copied into a clean job.
// Passed back to scheduleJob, it keeps that job's task as it is.
const HIDDEN_TASK = '[hidden: made by a run that read untrusted content; pass this text unchanged to keep the task]';

// A job run (or a sub-agent of one) may make or change this many jobs and
// tasks. What a job run made may make none: a task that makes a task a
// minute on would run on its own for ever. And no more than this many jobs
// and tasks that jobs made may wait at once.
const MAX_MADE_PER_RUN = 2;
const MAX_MADE_BY_JOBS = 5;

class SchedulerExecutor extends BaseExecutor {
    /** The run record of a job run or of its sub-agents (set by the Scheduler), or null. */
    _jobRun(context) {
        const run = context?.message?.metadata?.jobRun;
        return run && typeof run === 'object' && run.runId ? run : null;
    }

    /** Why this job run may not make or change a job or task, or null. Counts nothing. */
    _refuseFromJobRun(jobRun, scheduler, { creating }) {
        if (!jobRun) return null;
        if (jobRun.madeByJob === true) {
            return `This run belongs to '${jobRun.name}', which another job made; it cannot make or change jobs or tasks.`;
        }
        const entry = this._madeByRun?.get(String(jobRun.runId));
        if (entry && entry.count >= MAX_MADE_PER_RUN) {
            return `One job run may make or change at most ${MAX_MADE_PER_RUN} jobs or tasks.`;
        }
        if (creating) {
            const waiting = Object.values(scheduler.jobs || {}).filter(j => j?.metadata?.payload?.madeByJob === true).length;
            if (waiting >= MAX_MADE_BY_JOBS) {
                return `${waiting} jobs or tasks that jobs made are waiting already; no more can be made until they finish or the owner removes them.`;
            }
        }
        return null;
    }

    /** A job run made or changed a job or task. */
    _countMade(jobRun) {
        if (!jobRun) return;
        this._madeByRun = this._madeByRun || new Map();
        const now = Date.now();
        for (const [key, entry] of this._madeByRun) if (now - entry.at > 6 * 3600e3) this._madeByRun.delete(key);
        const key = String(jobRun.runId);
        const entry = this._madeByRun.get(key) || { count: 0, at: now };
        entry.count += 1;
        this._madeByRun.set(key, entry);
    }

    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const { scheduler } = services;
        const jobRun = this._jobRun(context);

        switch (name) {
            case 'scheduleJob': {
                const { name: jobName, cron, expiresAt } = args;
                if (!JOB_NAME_RE.test(String(jobName ?? ''))) {
                    return { error: 'A job name is 1 to 80 letters, digits, spaces and the signs _ . : -' };
                }
                // The same name changes that job in place. Before, the model
                // cancelled a job and made it again to change its end date; the
                // new job reported to the chat the change came from, and the
                // cancel deleted its saved state.
                const existing = scheduler.jobs?.[jobName];
                const prev = existing?.metadata?.payload || null;
                if (prev?.isSystem) {
                    return { error: `'${jobName}' is a built-in job. Its schedule and task cannot be changed here; the owner can change its model and tools on the Tasks page.` };
                }
                if (args.task === HIDDEN_TASK && !prev) {
                    return { error: 'That text stands for a hidden task. Give the task itself.' };
                }
                const task = args.task === HIDDEN_TASK ? prev.task : args.task;
                const sameTask = !!prev && prev.task === task;
                const sameCron = !!prev && String(existing.metadata?.cronExpression) === String(cron);
                // The times and task a job already has pass: the floor is for
                // new ones (extending a job that runs every 5 minutes works).
                const problem = sameCron && sameTask ? null : tooOften(cron);
                if (problem) {
                    return { error: `'${cron}' cannot be used: it ${problem}. A job made here needs five cron fields and runs at most every ${MIN_JOB_MINUTES} minutes; the owner can make a faster job on the Tasks page.` };
                }
                const refused = this._refuseFromJobRun(jobRun, scheduler, { creating: !prev });
                if (refused) return { error: refused };

                const keep = prev ? { targetChatId: prev.targetChatId, targetSource: prev.targetSource } : null;
                const { targetChatId, targetSource, taint } = originFor(context, scheduler, keep);
                // A job keeps the taint it was made with, whatever the change:
                // the model writes the new task, and may copy what a third
                // party planted. Only the owner's own re-save in the Tasks form
                // clears it. A row can be tainted with no sources named.
                let carried = taint;
                if (prev?.tainted === true) {
                    const merged = taintPayloadFields([...(prev.taintSources || []), ...(taint.taintSources || [])]);
                    carried = { tainted: true, ...(merged.taintSources ? { taintSources: merged.taintSources } : {}) };
                }
                // An unchanged task keeps its tool list.
                const allowedTools = sameTask && Array.isArray(prev.allowedTools)
                    ? prev.allowedTools
                    : await scheduler.scopeJobTools(task);
                // Left out, the end date stays as it was.
                const until = expiresAt || existing?.metadata?.expiresAt || undefined;
                // A job the owner paused stays paused: he turns it on in Tasks.
                const enabled = existing ? existing.metadata?.enabled !== false : true;

                const payload = {
                    task,
                    targetChatId,
                    targetSource,
                    ...(prev?.model ? { model: prev.model } : {}),
                    ...(allowedTools ? { allowedTools } : {}),
                    // The form's Weekdays and Daytime marks describe its times.
                    ...(sameCron && prev.weekdaysOnly ? { weekdaysOnly: true } : {}),
                    ...(sameCron && prev.daytimeOnly ? { daytimeOnly: true } : {}),
                    // Made or changed by a job run: it may not make jobs of its own.
                    ...(prev?.madeByJob === true || jobRun ? { madeByJob: true } : {}),
                    ...carried
                };
                // The same callback as after a restart: the run gets the
                // [SILENT] note, and only its final reply may go out.
                const callback = scheduler._buildAgentInstructionCallback(jobName, payload);

                const scheduled = scheduler.scheduleJob(jobName, cron, callback, {
                    persist: true,
                    taskType: 'agent_instruction',
                    payload,
                    expiresAt: until,
                    enabled
                });
                if (scheduled === false) {
                    return { error: `'${cron}' is not a schedule the scheduler understands.${prev ? ' The job was not changed.' : ''}` };
                }
                this._countMade(jobRun);
                return {
                    success: true,
                    info: `Job '${jobName}' ${prev ? 'changed' : 'scheduled'}: '${cron}'` + (until ? ` until ${until}` : '')
                        + (enabled ? '' : '. It stays paused; the owner turns it on in Tasks.')
                };
            }

            case 'setReminder': {
                const { time, message: reminderMessage } = args;
                const date = new Date(time);
                if (isNaN(date.getTime())) return { error: "Invalid date format." };
                if (date < new Date()) return { error: "Time must be in the future." };

                const parsedName = `reminder_${date.getTime()}_${Math.floor(Math.random() * 1000)}`;
                // A reminder only delivers its text; under taint it goes to the owner alone.
                const { targetChatId, targetSource, taint } = originFor(context, scheduler);

                // Reminders deliver a static text message. Do NOT route them through the
                // LLM — that caused double-messages (the agent would call sendMessage(to="me")
                // per NOTIFICATION_PROTOCOL AND reply with a confirmation, both delivered).
                // scheduler._buildDirectReminderCallback handles direct delivery + retries +
                // fallback notification, and is shared with loadJobs so persisted reminders
                // reconstruct with the same behavior after a restart.
                const initialPayload = {
                    task: `Reminder: ${reminderMessage}`,
                    reminderMessage,
                    isOneOff: true,
                    isReminder: true,
                    targetChatId,
                    targetSource,
                    retryCount: 0,
                    ...taint
                };

                const callback = scheduler._buildDirectReminderCallback(parsedName, initialPayload);

                scheduler.scheduleOneOff(parsedName, date, callback, {
                    persist: true,
                    taskType: 'reminder',
                    payload: initialPayload
                });
                return { success: true, info: `Reminder set for ${date.toLocaleString()}` };
            }

            case 'scheduleTask': {
                const { time, task } = args;
                const date = new Date(time);
                if (isNaN(date.getTime())) return { error: "Invalid date format." };
                if (date < new Date()) return { error: "Time must be in the future." };
                const refused = this._refuseFromJobRun(jobRun, scheduler, { creating: true });
                if (refused) return { error: refused };

                const parsedName = `task_${date.getTime()}_${Math.floor(Math.random() * 1000)}`;
                const { targetChatId, targetSource, taint } = originFor(context, scheduler);

                // Use the shared scheduler helper so in-memory scheduled tasks match
                // what loadJobs reconstructs after a restart — smart notification for
                // system-origin results, [SILENT] support, and a proper retry closure
                // (the old inline version captured retryCount=0 per-session, never
                // hitting MAX_RETRIES until the process restarted).
                const allowedTools = await scheduler.scopeJobTools(task);
                const initialPayload = {
                    task,
                    isOneOff: true,
                    targetChatId,
                    targetSource,
                    retryCount: 0,
                    ...(allowedTools ? { allowedTools } : {}),
                    ...(jobRun ? { madeByJob: true } : {}),
                    ...taint
                };

                const callback = scheduler._buildAgentInstructionCallback(parsedName, initialPayload);

                const scheduled = scheduler.scheduleOneOff(parsedName, date, callback, {
                    persist: true,
                    taskType: 'agent_instruction',
                    payload: initialPayload
                });
                if (scheduled === false) return { error: 'The task could not be scheduled.' };
                this._countMade(jobRun);
                return { success: true, info: `Task '${task}' scheduled for ${date.toLocaleString()}` };
            }

            case 'listJobs': {
                const jobList = [];
                for (const [name, job] of Object.entries(scheduler.jobs)) {
                    // Extract metadata from job object or DB payload if available
                    const meta = job.metadata || {};
                    const payload = meta.payload || {};
                    const tainted = payload.tainted === true;

                    jobList.push({
                        name: name,
                        cron: meta.cronExpression, // Original rule
                        // A task a third party may have written is not shown: its
                        // words would come back to a clean run as trusted text.
                        task: tainted ? HIDDEN_TASK : (payload.task || 'No description'),
                        nextInvocation: job.nextInvocation() ? job.nextInvocation().toISOString() : null,
                        expiresAt: meta.expiresAt,
                        ...(tainted ? { tainted: true } : {})
                    });
                }
                return { jobs: jobList };
            }

            case 'cancelJob': {
                // The Tasks page refuses this too: a built-in job comes back at
                // the next boot, but until then it would be gone.
                if (scheduler.jobs?.[args.name]?.metadata?.payload?.isSystem) {
                    return { error: `'${args.name}' is a built-in job and cannot be cancelled. The owner can pause it on the Tasks page.` };
                }
                scheduler.cancelJob(args.name);
                return { success: true };
            }

            default: return null;
        }
    }
}

module.exports = { SchedulerExecutor, originFor, tooOften, HIDDEN_TASK };
