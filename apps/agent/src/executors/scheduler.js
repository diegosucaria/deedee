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
 * Why a cron the model gave runs too often, or null. It must be a string of
 * five fields, or six whose seconds field is one number: node-schedule fills
 * the fields left out, so "* * * *" runs every minute.
 */
function tooOften(cron) {
    if (typeof cron !== 'string') return 'it is not a cron string';
    let fields = cron.trim().split(/\s+/);
    if (fields.length === 6) {
        if (!/^\d{1,2}$/.test(fields[0])) return 'it runs more than once a minute';
        fields = fields.slice(1);
    }
    if (fields.length !== 5) return 'it does not have five fields';
    const perHour = minutesPerHour(fields[0]);
    return perHour > 60 / MIN_JOB_MINUTES ? `it runs ${perHour} times an hour` : null;
}

// A job run may make this many jobs and tasks. What it makes cannot make
// more: a task that makes a task a minute on would run on its own for ever,
// and a run that makes several would double them each time.
const MAX_MADE_PER_RUN = 2;

class SchedulerExecutor extends BaseExecutor {
    /**
     * A job run (it carries metadata.jobName) that makes a job or a task:
     * why it may not, or null. Counts per run, in its own chat id.
     */
    _refuseFromJobRun(context, scheduler) {
        const meta = context?.message?.metadata || {};
        if (!meta.jobName) return null;
        const parent = scheduler.jobs?.[meta.jobName]?.metadata?.payload;
        if (parent?.madeByJob === true) {
            return `This run belongs to '${meta.jobName}', which another job made; it cannot make jobs or tasks.`;
        }
        this._madeByRun = this._madeByRun || new Map();
        const now = Date.now();
        for (const [key, entry] of this._madeByRun) if (now - entry.at > 6 * 3600e3) this._madeByRun.delete(key);
        const key = String(meta.jobRunId || meta.chatId || meta.jobName);
        const entry = this._madeByRun.get(key) || { count: 0, at: now };
        if (entry.count >= MAX_MADE_PER_RUN) {
            return `One job run may make at most ${MAX_MADE_PER_RUN} jobs or tasks.`;
        }
        entry.count += 1;
        this._madeByRun.set(key, entry);
        return null;
    }

    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const { scheduler } = services;
        const fromJobRun = !!context?.message?.metadata?.jobName;

        switch (name) {
            case 'scheduleJob': {
                const { name: jobName, cron, task, expiresAt } = args;
                // The same name changes that job in place. Before, the model
                // cancelled a job and made it again to change its end date; the
                // new job reported to the chat the change came from, and the
                // cancel deleted its saved state.
                const existing = scheduler.jobs?.[jobName];
                const prev = existing?.metadata?.payload || null;
                if (prev?.isSystem) {
                    return { error: `'${jobName}' is a built-in job. Its schedule and task cannot be changed here; the owner can change its model and tools on the Tasks page.` };
                }
                // Times the job already has pass: the floor is for new ones.
                const sameCron = !!prev && String(existing.metadata?.cronExpression) === String(cron);
                const often = sameCron ? null : tooOften(cron);
                if (often) {
                    return { error: `A job made here runs at most every ${MIN_JOB_MINUTES} minutes, and '${cron}' does not: ${often}. Pick a slower schedule; the owner can make a faster job on the Tasks page.` };
                }
                if (!prev) {
                    const refused = this._refuseFromJobRun(context, scheduler);
                    if (refused) return { error: refused };
                }
                const keep = prev ? { targetChatId: prev.targetChatId, targetSource: prev.targetSource } : null;
                const { targetChatId, targetSource, taint } = originFor(context, scheduler, keep);
                // A job keeps the taint it was made with, whatever the change:
                // the model writes the new task, and may copy what a third
                // party planted. Only the owner's own re-save in the Tasks form
                // clears it. A row can be tainted with no sources named.
                const sameTask = !!prev && prev.task === task;
                let carried = taint;
                if (prev?.tainted === true) {
                    const merged = taintPayloadFields([...(prev.taintSources || []), ...(taint.taintSources || [])]);
                    carried = { tainted: true, ...(merged.taintSources ? { taintSources: merged.taintSources } : {}) };
                }
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
                    // Made by a job run: it may not make jobs of its own.
                    ...(prev?.madeByJob === true || (!prev && fromJobRun) ? { madeByJob: true } : {}),
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

                // A job run's task starts at least as far out as the job floor.
                if (fromJobRun && date.getTime() - Date.now() < MIN_JOB_MINUTES * 60e3) {
                    return { error: `A task made by a job starts at least ${MIN_JOB_MINUTES} minutes from now.` };
                }
                const refused = this._refuseFromJobRun(context, scheduler);
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
                    ...(fromJobRun ? { madeByJob: true } : {}),
                    ...taint
                };

                const callback = scheduler._buildAgentInstructionCallback(parsedName, initialPayload);

                scheduler.scheduleOneOff(parsedName, date, callback, {
                    persist: true,
                    taskType: 'agent_instruction',
                    payload: initialPayload
                });
                return { success: true, info: `Task '${task}' scheduled for ${date.toLocaleString()}` };
            }

            case 'listJobs': {
                const jobList = [];
                for (const [name, job] of Object.entries(scheduler.jobs)) {
                    // Extract metadata from job object or DB payload if available
                    const meta = job.metadata || {};
                    const payload = meta.payload || {};

                    jobList.push({
                        name: name,
                        cron: meta.cronExpression, // Original rule
                        task: payload.task || 'No description',
                        nextInvocation: job.nextInvocation() ? job.nextInvocation().toISOString() : null,
                        expiresAt: meta.expiresAt,
                        // Its task came from a run that read untrusted content:
                        // the whole list then reads as such (untrusted-content.js).
                        ...(payload.tainted === true ? { tainted: true } : {})
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

module.exports = { SchedulerExecutor, originFor, tooOften };
