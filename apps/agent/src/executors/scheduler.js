const { BaseExecutor } = require('./base');

class SchedulerExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const { scheduler } = this.services;
        const { message, processMessage } = context;

        switch (name) {
            case 'scheduleJob': {
                const { name: jobName, cron, task } = args;
                const targetChatId = message.metadata?.chatId;
                const targetSource = message.source;

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
                    payload: { task, targetChatId, targetSource }
                });
                return { success: true, info: `Job '${jobName}' scheduled for '${cron}'` };
            }

            case 'setReminder': {
                const { time, message: reminderMessage } = args;
                const date = new Date(time);
                if (isNaN(date.getTime())) return { error: "Invalid date format." };
                if (date < new Date()) return { error: "Time must be in the future." };

                const parsedName = `reminder_${date.getTime()}_${Math.floor(Math.random() * 1000)}`;
                const targetChatId = message.metadata?.chatId;
                const targetSource = message.source;

                const callback = async () => {
                    const meta = { chatId: targetChatId || `reminder_${parsedName}` };
                    await processMessage({
                        role: 'user',
                        content: `System Instruction: It is now ${new Date().toLocaleTimeString()}. The user set a reminder: "${reminderMessage}". Please explicitly remind them now.`,
                        source: targetSource || 'scheduler',
                        metadata: meta
                    }, async (reply) => {
                        if (this.services.interface) {
                            await this.services.interface.send(reply);
                        }
                    });
                };

                scheduler.scheduleOneOff(parsedName, date, callback, {
                    persist: true,
                    taskType: 'agent_instruction',
                    payload: {
                        task: `Reminder: ${reminderMessage}`,
                        isOneOff: true,
                        targetChatId,
                        targetSource
                    }
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

                const callback = async () => {
                    const meta = { chatId: targetChatId || `task_${parsedName}` };
                    await processMessage({
                        role: 'user',
                        content: `Scheduled Instruction: ${task}`,
                        source: targetSource || 'scheduler',
                        metadata: meta
                    }, async (reply) => {
                        if (this.services.interface) {
                            await this.services.interface.send(reply);
                        }
                    });
                };

                scheduler.scheduleOneOff(parsedName, date, callback, {
                    persist: true,
                    taskType: 'agent_instruction',
                    payload: {
                        task: task,
                        isOneOff: true,
                        targetChatId,
                        targetSource
                    }
                });
                return { success: true, info: `Task '${task}' scheduled for ${date.toLocaleString()}` };
            }

            case 'listJobs': {
                const jobs = Object.keys(scheduler.jobs);
                return { jobs: jobs };
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
