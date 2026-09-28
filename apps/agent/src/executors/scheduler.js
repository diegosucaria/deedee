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

/**
 * The tools a job's task needs, picked once when the job is saved, as the
 * Tasks form does. A job runs with only these; null (no scoper, or it
 * failed) leaves every tool.
 */
async function scopeJobTools(services, task) {
    const agent = services.agent;
    if (!agent?.toolScoper) return null;
    try {
        const mcpTools = agent.mcp ? await agent.mcp.getTools() : [];
        return await agent.toolScoper.scope(task, mcpTools);
    } catch (e) {
        console.warn(`[Scheduler] Tool scoping failed, the job keeps every tool: ${e.message}`);
        return null;
    }
}

class SchedulerExecutor extends BaseExecutor {
    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const { scheduler } = services;

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
                const keep = prev ? { targetChatId: prev.targetChatId, targetSource: prev.targetSource } : null;
                const { targetChatId, targetSource, taint } = originFor(context, scheduler, keep);
                // An unchanged task keeps its tool list and the taint it was
                // made with, as a re-save from the Tasks form does.
                const sameTask = !!prev && prev.task === task;
                const carried = sameTask && prev.tainted === true
                    ? taintPayloadFields([...(prev.taintSources || []), ...(taint.taintSources || [])])
                    : taint;
                const allowedTools = sameTask && Array.isArray(prev.allowedTools)
                    ? prev.allowedTools
                    : await scopeJobTools(services, task);
                const until = expiresAt || existing?.metadata?.expiresAt || undefined;

                const payload = {
                    task,
                    targetChatId,
                    targetSource,
                    ...(prev?.model ? { model: prev.model } : {}),
                    ...(allowedTools ? { allowedTools } : {}),
                    ...(prev?.weekdaysOnly ? { weekdaysOnly: true } : {}),
                    ...(prev?.daytimeOnly ? { daytimeOnly: true } : {}),
                    ...carried
                };
                // The same callback as after a restart: the run gets the
                // [SILENT] note, and only its final reply may go out.
                const callback = scheduler._buildAgentInstructionCallback(jobName, payload);

                scheduler.scheduleJob(jobName, cron, callback, {
                    persist: true,
                    taskType: 'agent_instruction',
                    payload,
                    expiresAt: until
                });
                return { success: true, info: `Job '${jobName}' ${prev ? 'changed' : 'scheduled'}: '${cron}'` + (until ? ` until ${until}` : '') };
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
                const allowedTools = await scopeJobTools(services, task);
                const initialPayload = {
                    task,
                    isOneOff: true,
                    targetChatId,
                    targetSource,
                    retryCount: 0,
                    ...(allowedTools ? { allowedTools } : {}),
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
