const schedule = require('node-schedule');

class Scheduler {
    constructor(agent) {
        this.agent = agent;
        this.jobs = {}; // Store job references
        console.log('[Scheduler] Initialized.');
    }

    /**
     * Schedule a recurring job.
     * @param {string} name - Unique job name
     * @param {string} cronExpression - Cron rule (e.g., '0 8 * * *')
     * @param {function} callback - Async function to run
     * @param {object} options - { persist: boolean, taskType: string, payload: object }
     */
    scheduleJob(name, cronExpression, callback, options = {}) {
        if (this.jobs[name]) {
            this.jobs[name].cancel();
        }

        // Handle Date object or ISO string for one-off jobs
        let rule = cronExpression;
        if (options.oneOff || !isNaN(Date.parse(cronExpression))) {
            rule = new Date(cronExpression);
        }

        const job = schedule.scheduleJob(rule, async () => {
            console.log(`[Scheduler] Running job: ${name}`);
            try {
                await callback();
            } catch (err) {
                console.error(`[Scheduler] Job ${name} failed:`, err);
            }

            // Auto-cleanup one-off jobs
            if (options.oneOff) {
                console.log(`[Scheduler] One-off job '${name}' completed. Cleaning up...`);
                delete this.jobs[name];
                this.agent.db.deleteScheduledJob(name);
            }
        });

        if (!job) {
            console.error(`[Scheduler] Failed to schedule job '${name}'. Rule: ${rule}`);
            return;
        }

        this.jobs[name] = job;
        this.jobs[name].metadata = { name, cronExpression, createdAt: new Date() }; // cronExpression here might be ISO string

        // Ensure payload is stored in memory for API access
        this.jobs[name].metadata.payload = options.payload || {};
        if (options.oneOff) this.jobs[name].metadata.payload.isOneOff = true;

        if (options.persist) {
            this.agent.db.saveScheduledJob({
                name,
                cronExpression: typeof cronExpression === 'string' ? cronExpression : cronExpression.toISOString(),
                taskType: options.taskType || 'custom',
                payload: { ...options.payload, isOneOff: !!options.oneOff }
            });
        }
        console.log(`[Scheduler] Job '${name}' scheduled. OneOff: ${!!options.oneOff}`);
    }

    cancelJob(name) {
        if (this.jobs[name]) {
            this.jobs[name].cancel();
            delete this.jobs[name];

            // Remove from DB
            this.agent.db.deleteScheduledJob(name);
            console.log(`[Scheduler] Job '${name}' cancelled and removed from DB.`);
        }
    }

    async loadJobs() {
        console.log('[Scheduler] Loading persisted jobs...');
        const jobs = this.agent.db.getScheduledJobs();
        for (const jobData of jobs) {
            const { name, cronExpression, taskType, payload } = jobData;

            // Skip system jobs (let ensureSystemJobs recreate them with correct callbacks/logic)
            if (payload && payload.isSystem) {
                console.log(`[Scheduler] Skipping system job '${name}' load (will be ensured later).`);
                continue;
            }

            let callback;
            if (taskType === 'agent_instruction' && payload.task) {
                // Reconstruct agent instruction callback
                callback = async () => {
                    console.log(`[Scheduler] Executing persisted task: ${payload.task}`);

                    const msgSource = payload.targetSource || 'scheduler';
                    const msgMeta = {
                        chatId: payload.targetChatId || `scheduled_${name}_${Date.now()}`
                    };

                    await this.agent.processMessage({
                        role: 'user',
                        content: `Scheduled Task: ${payload.task}`,
                        source: msgSource,
                        metadata: msgMeta
                    }, async (reply) => {
                        if (this.agent.interface) {
                            await this.agent.interface.send(reply);
                        }
                    });
                };
            } else {
                console.warn(`[Scheduler] Unknown task type '${taskType}' for job '${name}'. Skipping.`);
                continue;
            }

            // Schedule without re-persisting
            this.scheduleJob(name, cronExpression, callback, { persist: false, taskType, payload });
        }
        console.log(`[Scheduler] Loaded ${Object.keys(this.jobs).length} jobs from DB.`);
    }

    /**
     * Ensures critical system jobs exist.
     */
    ensureSystemJobs() {
        const SYSTEM_JOBS = [
            {
                name: 'nightly_consolidation',
                cron: '0 0 * * *', // Midnight
                task: 'Run consolidateMemory tool to summarize yesterday\'s logs into the journal.'
            },
            {
                name: 'nightly_backup',
                cron: '0 2 * * *', // 2 AM
                task: 'Perform nightly backup of data to GCS.'
            }
        ];

        console.log('[Scheduler] Verifying system jobs...');
        for (const sysJob of SYSTEM_JOBS) {
            if (!this.jobs[sysJob.name]) {
                console.log(`[Scheduler] System job '${sysJob.name}' missing. Creating...`);
                // Use the standard scheduleJob logic which handles the callback wrapper
                // We manually construct the instruction wrapper to match 'agent_instruction' type
                const callback = async () => {
                    console.log(`[Scheduler] Executing SYSTEM task: ${sysJob.task}`);

                    // Direct Execution for Backup (Bypass Agent LLM to avoid context window usage/failures and ensure reliability)
                    if (sysJob.name === 'nightly_backup') {
                        try {
                            const result = await this.agent.backupManager.performBackup();
                            console.log('[Scheduler] Nightly Backup Result:', result);
                        } catch (err) {
                            console.error('[Scheduler] Nightly Backup Failed:', err);
                        }
                        return;
                    }

                    await this.agent.processMessage({
                        role: 'user',
                        content: `System Maintenance: ${sysJob.task}`,
                        source: 'scheduler',
                        metadata: { chatId: `system_${sysJob.name}_${Date.now()}` }
                    }, async (reply) => {
                        // Fire and forget response
                        if (this.agent.interface) await this.agent.interface.send(reply);
                    });
                };

                this.scheduleJob(sysJob.name, sysJob.cron, callback, {
                    persist: true,
                    taskType: 'agent_instruction',
                    payload: { task: sysJob.task, isSystem: true }
                });
            }
        }
    }

    /**
     * Schedule a one-off reminder.
     */
    scheduleOneOff(name, date, callback, options = {}) {
        this.scheduleJob(name, date, callback, { ...options, oneOff: true });
    }
}

module.exports = { Scheduler };
