const { BaseExecutor } = require('./base');

class SchedulerExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const { scheduler } = this.services;
        const { message, processMessage } = context;

        switch (name) {
            case 'scheduleJob': {
                const { name: jobName, cron, task, expiresAt } = args;
                const targetChatId = message.metadata?.chatId;
                const targetSource = message.source;

                // NOTE: Recurring jobs (scheduleJob) generally do NOT retry on failure in the same way 
                // because they run again on the next cron interval. 
                // However, user asked for "one-offs" specifically. 
                // We'll leave recurring jobs as-is for now (simple execution) unless requested otherwise.

                const callback = async () => {
                    const meta = { chatId: targetChatId || `scheduled_${jobName}_${Date.now()}` };
                    await processMessage({
                        role: 'user',
                        content: `Scheduled Task: ${task}`,
                        source: targetSource || 'scheduler',
                        metadata: meta
                    }, async (reply) => {
                        if (this.services.interface) {
                            await this.services.interface.send(reply);
                        }
                    });
                };

                scheduler.scheduleJob(jobName, cron, callback, {
                    persist: true,
                    taskType: 'agent_instruction',
                    payload: { task, targetChatId, targetSource },
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
                const targetChatId = message.metadata?.chatId;
                const targetSource = message.source;

                // Define the logic in a reusable way or inline it
                const createCallback = (currentPayload) => async () => {
                    const meta = { chatId: targetChatId || `reminder_${parsedName}` };
                    console.log(`[Executor] Running Reminder (Retry: ${currentPayload.retryCount || 0})`);

                    try {
                        const summary = await processMessage({
                            role: 'user',
                            content: `System Instruction: It is now ${new Date().toLocaleTimeString()}. The user set a reminder: "${reminderMessage}". Please explicitly remind them now.`,
                            source: targetSource || 'scheduler',
                            metadata: meta
                        }, async (reply) => {
                            if (this.services.interface) {
                                // Default reply to origin
                                await this.services.interface.send(reply);

                                // Explicit Push Notification to Owner
                                const agent = this.services.agent;
                                const settings = agent?.settings || {};
                                const ownerPhone = settings.owner_phone;
                                const channel = settings.notification_channel || 'whatsapp';

                                if (ownerPhone) {
                                    console.log(`[Executor] Pushing reminder to owner (${ownerPhone}) via ${channel}`);
                                    await this.services.interface.send({
                                        ...reply,
                                        to: ownerPhone,
                                        platform: channel,
                                        isNotification: true // Flag to possibly bypass certain checks or formatting
                                    });
                                }
                            }
                        });

                        // Verification
                        // Reminders are successful if they produce ANY non-error output
                        const failures = ["I received an empty response", "Error:", "No text response found"];
                        const success = summary && summary.replies.some(r => r.content && !failures.some(f => r.content.includes(f)));

                        if (!success) throw new Error("Agent execution failed.");

                    } catch (error) {
                        console.error(`[Executor] Reminder '${parsedName}' failed:`, error.message);
                        const currentRetry = currentPayload.retryCount || 0;
                        const MAX_RETRIES = 3;

                        if (currentRetry < MAX_RETRIES) {
                            // Reschedule
                            scheduler.scheduleOneOff(parsedName, new Date(Date.now() + 60000), createCallback({ ...currentPayload, retryCount: currentRetry + 1 }), {
                                persist: true,
                                taskType: 'agent_instruction',
                                payload: { ...currentPayload, retryCount: currentRetry + 1 }
                            });
                        } else {
                            // Slack Alert
                            if (process.env.SLACK_WEBHOOK_URL) {
                                try {
                                    await fetch(process.env.SLACK_WEBHOOK_URL, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            text: `🚨 *Reminder Failure*\n\nFailed to deliver reminder: *"${reminderMessage}"*\nError: ${error.message}`
                                        })
                                    });
                                } catch (e) { console.error(e); }
                            }
                        }
                    }
                };

                const initialPayload = {
                    task: `Reminder: ${reminderMessage}`,
                    isOneOff: true,
                    targetChatId,
                    targetSource,
                    retryCount: 0
                };

                scheduler.scheduleOneOff(parsedName, date, createCallback(initialPayload), {
                    persist: true,
                    taskType: 'agent_instruction',
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
                const targetChatId = message.metadata?.chatId;
                const targetSource = message.source;

                const createCallback = (currentPayload) => async () => {
                    const meta = { chatId: targetChatId || `task_${parsedName}` };
                    console.log(`[Executor] Running One-Off Task (Retry: ${currentPayload.retryCount || 0})`);

                    try {
                        const summary = await processMessage({
                            role: 'user',
                            content: `Scheduled Instruction: ${task}`,
                            source: targetSource || 'scheduler',
                            metadata: meta
                        }, async (reply) => {
                            if (this.services.interface) {
                                await this.services.interface.send(reply);
                            }
                        });

                        const failures = ["I received an empty response", "Error:", "No text response found"];
                        const success = summary && summary.replies.some(r => r.content && !failures.some(f => r.content.includes(f)));

                        if (!success) throw new Error("Agent execution failed.");

                    } catch (error) {
                        console.error(`[Executor] Task '${parsedName}' failed:`, error.message);
                        const currentRetry = currentPayload.retryCount || 0;
                        const MAX_RETRIES = 3;

                        if (currentRetry < MAX_RETRIES) {
                            scheduler.scheduleOneOff(parsedName, new Date(Date.now() + 60000), createCallback({ ...currentPayload, retryCount: currentRetry + 1 }), {
                                persist: true,
                                taskType: 'agent_instruction',
                                payload: { ...currentPayload, retryCount: currentRetry + 1 }
                            });
                        } else {
                            if (process.env.SLACK_WEBHOOK_URL) {
                                try {
                                    await fetch(process.env.SLACK_WEBHOOK_URL, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            text: `🚨 *Task Failure Alert*\n\nTask *"${task}"* failed after 3 retries.\nError: ${error.message}`
                                        })
                                    });
                                } catch (e) { console.error(e); }
                            }
                        }
                    }
                };

                const initialPayload = {
                    task: task,
                    isOneOff: true,
                    targetChatId,
                    targetSource,
                    retryCount: 0
                };

                scheduler.scheduleOneOff(parsedName, date, createCallback(initialPayload), {
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

module.exports = { SchedulerExecutor };
