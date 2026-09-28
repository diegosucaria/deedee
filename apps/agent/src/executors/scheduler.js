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

/** How many values a cron field takes in [lo, hi]; a name (MON, JAN) counts once. */
function fieldCount(field, lo, hi) {
    const text = String(field);
    if (text === '*' || text === '?') return hi - lo + 1;
    let count = 0;
    for (const part of text.split(',')) {
        const [range, stepText] = part.split('/');
        const step = stepText ? Math.max(1, parseInt(stepText, 10) || 1) : 1;
        let from = lo;
        let to = hi;
        if (range.includes('-')) {
            const [a, b] = range.split('-').map(Number);
            if (!(Number.isFinite(a) && Number.isFinite(b) && b >= a)) { count += 1; continue; }
            from = a;
            to = b;
        } else if (range !== '*') {
            const n = Number(range);
            if (!Number.isFinite(n) || !stepText) { count += 1; continue; }
            from = n;
        }
        count += Math.floor((to - from) / step) + 1;
    }
    return Math.min(Math.max(count, 1), hi - lo + 1);
}

// node-schedule's aliases, as cron-parser reads them.
const ALIAS_FIELDS = { '@yearly': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@hourly': '0 * * * *' };
const CRON_NAMES = { sun: '0', mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6', jan: '1', feb: '2', mar: '3', apr: '4', may: '5', jun: '6', jul: '7', aug: '8', sep: '9', oct: '10', nov: '11', dec: '12' };

/** The five fields of a schedule, day and month names as numbers, or null. */
function cronFields(cron) {
    const spec = String(cron || '').trim();
    let fields = (ALIAS_FIELDS[spec] || spec).split(/\s+/);
    if (fields.length === 6) fields = fields.slice(1);
    if (fields.length !== 5) return null;
    return fields.map(f => f.toLowerCase().replace(/[a-z]{3}/g, name => CRON_NAMES[name] ?? name));
}

/**
 * New times that run no more often than the old ones: the same days of the
 * month and months, weekdays no more of them (a field with anything but
 * digits, "*", ",", "-" and "/" stays as it was), and no more minutes times
 * hours a day. Averages over a week or a year would let a schedule held to
 * a few days look rare.
 */
function noMoreOften(oldCron, newCron) {
    const a = cronFields(oldCron);
    const b = cronFields(newCron);
    if (!a || !b) return false;
    if (a[2] !== b[2] || a[3] !== b[3]) return false;
    const plain = (f) => /^[\d*,/-]+$/.test(f);
    if (a[4] !== b[4]) {
        if (!plain(a[4]) || !plain(b[4])) return false;
        if (fieldCount(b[4], 0, 6) > fieldCount(a[4], 0, 6)) return false;
    }
    if (!plain(a[0]) || !plain(a[1]) || !plain(b[0]) || !plain(b[1])) return a[0] === b[0] && a[1] === b[1];
    return fieldCount(b[0], 0, 59) * fieldCount(b[1], 0, 23) <= fieldCount(a[0], 0, 59) * fieldCount(a[1], 0, 23);
}

/**
 * A run typed in one of the owner's own chats (web, his WhatsApp or
 * Telegram chat with the assistant): not a job run, a sub-agent or a
 * watcher run on a contact's message.
 */
async function ownChatRun(context, scheduler) {
    const message = context?.message || {};
    const meta = message.metadata || {};
    if (meta.jobRun || meta.isSubAgent || String(message.content || '').startsWith('SYSTEM_WATCHER_ALERT')) return false;
    // A message that carries someone else's words (a forwarded one) is not his
    // word, as for the owner's-consent rule (ApprovalService._ownerConsent).
    if (Array.isArray(meta.untrustedTaint) && meta.untrustedTaint.length > 0) return false;
    const channel = String(message.source || '').split(':')[0];
    if (!['web', 'whatsapp', 'telegram'].includes(channel) || !meta.chatId) return false;
    // A WhatsApp or Slack chat opened on the web holds a contact's words.
    if (channel === 'web' && /@|%40/.test(String(meta.chatId))) return false;
    if (typeof scheduler?.agent?._getOwnerWaIds === 'function') {
        try { await scheduler.agent._getOwnerWaIds(); } catch { /* the phone JID still counts */ }
    }
    return typeof scheduler?._isOwnerOrigin === 'function' && scheduler._isOwnerOrigin(message.source, meta.chatId);
}

// The name of a new job: something the Tasks page, the logs and the
// database can show. A run that read untrusted content gets a plain slug, so
// a name cannot carry a sentence back to a clean run through listJobs.
const JOB_NAME_RE = /^[\p{L}\p{N} _.:-]{1,80}$/u;
const TAINTED_JOB_NAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;

// An end date is a date. Any other text never parses, so the job never ended,
// and it came back to clean runs through listJobs.
const END_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Task texts as the Tasks form and the model send them: line ends and edges aside. */
const sameText = (a, b) => String(a ?? '').replace(/\r\n?/g, '\n').trim() === String(b ?? '').replace(/\r\n?/g, '\n').trim();

// A job run, its sub-agents included, makes at most this many one-time
// tasks. A task a job run made makes none, and no job run makes or changes a
// repeating job: the owner makes those, in his chat or in the Tasks form.
// Without this, a task could make a task a minute on and run for ever, with
// no rate limit and, answering [SILENT], no sound.
const MAX_TASKS_PER_RUN = 2;

class SchedulerExecutor extends BaseExecutor {
    /** The run record of a job run or of its sub-agents (set by the Scheduler), or null. */
    _jobRun(context) {
        const run = context?.message?.metadata?.jobRun;
        return run && typeof run === 'object' && run.runId ? run : null;
    }

    /**
     * A job run that makes a one-time task takes a slot first. The count is
     * checked and taken with no await in between, so calls made side by side
     * in one turn cannot all pass. Returns { error } or { release }: release
     * it when no task was saved.
     */
    _takeTaskSlot(jobRun) {
        if (!jobRun) return { release() { } };
        if (jobRun.madeByJob === true) {
            return { error: `This run belongs to '${jobRun.name}', which a job made; it cannot make tasks.` };
        }
        this._tasksByRun = this._tasksByRun || new Map();
        const now = Date.now();
        for (const [key, entry] of this._tasksByRun) if (now - entry.at > 6 * 3600e3) this._tasksByRun.delete(key);
        const key = String(jobRun.runId);
        const entry = this._tasksByRun.get(key) || { count: 0, at: now };
        if (entry.count >= MAX_TASKS_PER_RUN) {
            return { error: `One job run may make at most ${MAX_TASKS_PER_RUN} tasks.` };
        }
        entry.count += 1;
        this._tasksByRun.set(key, entry);
        let released = false;
        return { release() { if (!released) { released = true; entry.count -= 1; } } };
    }

    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const { scheduler } = services;
        const jobRun = this._jobRun(context);
        // His WhatsApp chat carries his @lid id, which only the owner id lookup
        // knows (cached after the first call): which chat is his decides where a
        // job reports and what listJobs shows. Before any slot is taken.
        if (['scheduleJob', 'scheduleTask', 'setReminder', 'listJobs'].includes(name) && typeof scheduler?.agent?._getOwnerWaIds === 'function') {
            try { await scheduler.agent._getOwnerWaIds(); } catch { /* the phone JID still counts */ }
        }

        switch (name) {
            case 'scheduleJob': {
                const { name: jobName, cron, expiresAt } = args;
                if (jobRun) {
                    return { error: "A job's run cannot make or change repeating jobs; the owner makes those. For a one-time follow-up use scheduleTask, or setReminder for a reminder." };
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
                if (prev?.isOneOff === true) {
                    return { error: `'${jobName}' is a one-time task, not a repeating job. To move it, cancel it and make a new one with scheduleTask (setReminder for a reminder).` };
                }
                const { targetChatId, targetSource, taint } = originFor(context, scheduler, prev ? { targetChatId: prev.targetChatId, targetSource: prev.targetSource } : null);
                if (!prev) {
                    const nameRule = taint.tainted ? TAINTED_JOB_NAME_RE : JOB_NAME_RE;
                    if (!nameRule.test(String(jobName ?? ''))) {
                        return { error: taint.tainted
                            ? 'A new job name here is 1 to 40 letters, digits, _ or -, with no spaces.'
                            : 'A job name is 1 to 80 letters, digits, spaces and the signs _ . : -' };
                    }
                }
                if (expiresAt && (!END_DATE_RE.test(String(expiresAt)) || Number.isNaN(Date.parse(expiresAt)))) {
                    return { error: `The end date must be an ISO 8601 date, such as 2026-10-01T23:59:00. '${expiresAt}' is not.` };
                }
                // Left out, an existing job keeps its task: listJobs does not
                // show the task of a job a tainted run made (taskHidden).
                const given = typeof args.task === 'string' && args.task.trim() ? args.task : null;
                if (!given && !prev) return { error: 'A new job needs a task.' };
                const task = given ?? prev.task;
                const sameTask = !!prev && sameText(prev.task, task);
                const sameCron = !!prev && String(existing.metadata?.cronExpression) === String(cron);
                // The times and task a job already has pass: the floor is for
                // new ones (extending a job that runs every 5 minutes works).
                const problem = sameCron && sameTask ? null : tooOften(cron);
                if (problem) {
                    return { error: `'${cron}' cannot be used: it ${problem}. A job made here needs five cron fields and runs at most every ${MIN_JOB_MINUTES} minutes; the owner can make a faster job on the Tasks page.` };
                }
                // Left out, the end date stays as it was.
                const until = expiresAt || existing?.metadata?.expiresAt || undefined;
                if (prev && sameTask && sameCron && (until ?? null) === (existing.metadata?.expiresAt ?? null)) {
                    return existing.metadata?.enabled === false
                        ? { success: true, info: `Job '${jobName}' has that schedule and task, and it is paused; nothing changed. The owner turns it on in Tasks.` }
                        : { success: true, info: `Job '${jobName}' already runs at '${cron}' with that task; nothing changed.` };
                }
                // A job keeps the taint it was made with, whatever the change:
                // the model writes the new task, and may copy what a third
                // party planted. Only the owner's own re-save in the Tasks form
                // clears it. A row can be tainted with no sources named.
                // scheduleJob runs unasked in a tainted run because the job
                // stores the run's taint. One change is spared: new times or a
                // new end date typed in one of his own chats, running no more
                // often and ending no later ("move my briefing before my first
                // meeting" reads his calendar). A contact's message, a sub-agent
                // or a job run that moves a job taints it.
                const oldEnd = existing?.metadata?.expiresAt ? Date.parse(existing.metadata.expiresAt) : Infinity;
                const newEnd = until ? Date.parse(until) : Infinity;
                const spared = sameTask && taint.tainted
                    && noMoreOften(existing.metadata?.cronExpression, cron)
                    && newEnd <= oldEnd
                    && await ownChatRun(context, scheduler);
                let carried = spared ? {} : taint;
                if (prev?.tainted === true) {
                    const merged = taintPayloadFields([...(prev.taintSources || []), ...(carried.taintSources || [])]);
                    carried = { tainted: true, ...(merged.taintSources ? { taintSources: merged.taintSources } : {}) };
                }
                // An unchanged task keeps its tool list.
                const allowedTools = sameTask && Array.isArray(prev.allowedTools)
                    ? prev.allowedTools
                    : await scheduler.scopeJobTools(task);
                // A job the owner paused stays paused: he turns it on in Tasks.
                const enabled = existing ? existing.metadata?.enabled !== false : true;

                const payload = {
                    task: sameTask ? prev.task : task,
                    targetChatId,
                    targetSource,
                    ...(prev?.model ? { model: prev.model } : {}),
                    ...(allowedTools ? { allowedTools } : {}),
                    // The form's Weekdays and Daytime marks describe its times.
                    ...(sameCron && prev.weekdaysOnly ? { weekdaysOnly: true } : {}),
                    ...(sameCron && prev.daytimeOnly ? { daytimeOnly: true } : {}),
                    ...(prev?.madeByJob === true ? { madeByJob: true } : {}),
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
                    // A marked job run (see Scheduler, markOwner) that read
                    // untrusted content: the text it sends later carries the
                    // mark, as its sendMessage does. A reminder set in his own
                    // chat, or by a built-in or form job, does not.
                    ...(jobRun?.markOwner === true && taint.tainted ? { markOnDelivery: true } : {}),
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
                const slot = this._takeTaskSlot(jobRun);
                if (slot.error) return { error: slot.error };
                let saved = false;
                try {
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
                        // Made by a job run: its own run may make no tasks.
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
                    saved = true;
                    return { success: true, info: `Task '${task}' scheduled for ${date.toLocaleString()}` };
                } finally {
                    if (!saved) slot.release();
                }
            }

            case 'listJobs': {
                const jobList = [];
                let hidden = false;
                for (const [name, job] of Object.entries(scheduler.jobs)) {
                    // Extract metadata from job object or DB payload if available
                    const meta = job.metadata || {};
                    const payload = meta.payload || {};
                    // A task a run wrote after reading untrusted content may hold a
                    // third party's words: this list is trusted, so it leaves them
                    // out. A reminder he set in his own chat stays: it only repeats
                    // a text he will read anyway, and he must be able to find it.
                    // One a watcher run, a sub-agent or a job set is hidden.
                    const origin = scheduler._jobOrigin?.(payload);
                    const ownReminder = payload.isReminder === true && payload.markOnDelivery !== true && !!origin
                        && ['web', 'whatsapp', 'telegram'].includes(origin.source.split(':')[0])
                        && scheduler._isOwnerOrigin(origin.source, origin.chatId);
                    const taskHidden = payload.tainted === true && !ownReminder;
                    if (taskHidden) hidden = true;

                    jobList.push({
                        name: name,
                        cron: meta.cronExpression, // Original rule
                        task: taskHidden ? null : (payload.task || 'No description'),
                        ...(taskHidden ? { taskHidden: true } : {}),
                        ...(meta.enabled === false ? { paused: true } : {}),
                        nextInvocation: job.nextInvocation() ? job.nextInvocation().toISOString() : null,
                        expiresAt: meta.expiresAt
                    });
                }
                return {
                    jobs: jobList,
                    ...(hidden ? { note: 'A job with taskHidden was made by a run that read content a third party wrote; its task is on the Tasks page. To change its times or end date, call scheduleJob with its name and no task.' } : {})
                };
            }

            case 'cancelJob': {
                const target = scheduler.jobs?.[args.name];
                // The Tasks page refuses this too: a built-in job comes back at
                // the next boot, but until then it would be gone.
                if (target?.metadata?.payload?.isSystem) {
                    return { error: `'${args.name}' is a built-in job and cannot be cancelled. The owner can pause it on the Tasks page.` };
                }
                // A job's run deletes only its own job or a task a job made: a
                // planted order could otherwise delete the owner's jobs.
                if (jobRun && target && args.name !== jobRun.name && target.metadata?.payload?.madeByJob !== true) {
                    return { error: `A job's run can cancel only its own job or a task a job made. '${args.name}' is the owner's; he can remove it on the Tasks page.` };
                }
                scheduler.cancelJob(args.name);
                return { success: true };
            }

            default: return null;
        }
    }
}

module.exports = { SchedulerExecutor, originFor, tooOften, noMoreOften };
