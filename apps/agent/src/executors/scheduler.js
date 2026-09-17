const { BaseExecutor } = require('./base');
const { taintPayloadFields, taintFromPayload } = require('../utils/untrusted-content');

/**
 * Where a job, task or reminder created in this run reports, and the taint
 * it carries. A run that read untrusted content stores its sources on the
 * job (payload.tainted, payload.taintSources), so every later run starts
 * tainted and its outward actions ask the owner. Such a job never reports
 * to a contact's chat: when the run did not come from one of the owner's
 * chats, the target is dropped and the owner channel gets the result.
 */
function originFor(context, scheduler) {
    const message = context?.message || {};
    let targetChatId = message.metadata?.chatId;
    let targetSource = message.source;
    const taint = taintPayloadFields(context?.untrustedTaint);
    if (taint.tainted && targetChatId && scheduler && typeof scheduler._isOwnerOrigin === 'function'
        && !scheduler._isOwnerOrigin(targetSource, targetChatId)) {
        targetChatId = undefined;
        targetSource = undefined;
    }
    return { targetChatId, targetSource, taint };
}

class SchedulerExecutor extends BaseExecutor {
    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const { scheduler } = services;
        const { processMessage } = context;

        switch (name) {
            case 'scheduleJob': {
                const { name: jobName, cron, task, expiresAt } = args;
                const { targetChatId, targetSource, taint } = originFor(context, scheduler);

                // NOTE: Recurring jobs (scheduleJob) generally do NOT retry on failure in the same way 
                // because they run again on the next cron interval. 
                // However, user asked for "one-offs" specifically. 
                // We'll leave recurring jobs as-is for now (simple execution) unless requested otherwise.

                const callback = async () => {
                    const meta = { chatId: targetChatId || `scheduled_${jobName}_${Date.now()}`, jobName };
                    const inherited = taintFromPayload(taint, `job "${jobName}"`);
                    if (inherited.length > 0) meta.untrustedTaint = inherited;
                    await processMessage({
                        role: 'user',
                        content: `Scheduled Task: ${task}`,
                        source: targetSource || 'scheduler',
                        metadata: meta
                    }, async (reply) => {
                        if (services.interface) {
                            await services.interface.send(reply);
                        }
                    });
                };

                scheduler.scheduleJob(jobName, cron, callback, {
                    persist: true,
                    taskType: 'agent_instruction',
                    payload: { task, targetChatId, targetSource, ...taint },
                    expiresAt: expiresAt
                });
                return { success: true, info: `Job '${jobName}' scheduled for '${cron}'` + (expiresAt ? ` until ${expiresAt}` : '') };
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

                const parsedName = `task_${date.getTime()}_${Math.floor(Math.random() * 1000)}`;
                const { targetChatId, targetSource, taint } = originFor(context, scheduler);

                // Use the shared scheduler helper so in-memory scheduled tasks match
                // what loadJobs reconstructs after a restart — smart notification for
                // system-origin results, [SILENT] support, and a proper retry closure
                // (the old inline version captured retryCount=0 per-session, never
                // hitting MAX_RETRIES until the process restarted).
                const initialPayload = {
                    task,
                    isOneOff: true,
                    targetChatId,
                    targetSource,
                    retryCount: 0,
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
                        expiresAt: meta.expiresAt
                    });
                }
                return { jobs: jobList };
            }

            case 'cancelJob': {
                scheduler.cancelJob(args.name);
                return { success: true };
            }

            default: return null;
        }
    }
}

module.exports = { SchedulerExecutor, originFor };
