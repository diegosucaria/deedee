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
        if (options.oneOff) {
            rule = new Date(cronExpression);
        }

        const job = schedule.scheduleJob(rule, async () => {
            console.log(`[Scheduler] Running job: ${name}`);

            // Expiration Check
            if (options.expiresAt) {
                const expiry = new Date(options.expiresAt).getTime();
                if (Date.now() > expiry) {
                    console.log(`[Scheduler] Job '${name}' has expired (Expires: ${options.expiresAt}). Cancelling and Removing.`);
                    this.cancelJob(name);
                    return;
                }
            }

            const start = Date.now();
            let status = 'success';
            let output = null;

            try {
                const result = await callback();
                // Store result as output if it's a string or object
                if (result) {
                    output = typeof result === 'object' ? JSON.stringify(result) : String(result);
                }
            } catch (err) {
                console.error(`[Scheduler] Job ${name} failed:`, err);
                status = 'failure';
                output = err.message;
            }

            const duration = Date.now() - start;
            if (this.agent.db) {
                this.agent.db.logJobExecution(name, status, output, duration);
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
        this.jobs[name] = job;
        this.jobs[name].metadata = {
            name,
            cronExpression,
            createdAt: new Date(),
            expiresAt: options.expiresAt
        }; // cronExpression here might be ISO string

        // Ensure payload is stored in memory for API access
        this.jobs[name].metadata.payload = options.payload || {};
        if (options.oneOff) this.jobs[name].metadata.payload.isOneOff = true;

        if (options.persist) {
            this.agent.db.saveScheduledJob({
                name,
                cronExpression: typeof cronExpression === 'string' ? cronExpression : cronExpression.toISOString(),
                taskType: options.taskType || 'custom',
                payload: { ...options.payload, isOneOff: !!options.oneOff },
                expiresAt: options.expiresAt
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
            const { name, cronExpression, taskType, payload, expiresAt } = jobData;

            // Load-time Expiration Check
            if (expiresAt) {
                const expiry = new Date(expiresAt).getTime();
                if (Date.now() > expiry) {
                    console.log(`[Scheduler] Found expired job '${name}' during load. Deleting.`);
                    this.agent.db.deleteScheduledJob(name);
                    continue;
                }
            }

            // Skip system jobs (let ensureSystemJobs recreate them with correct callbacks/logic)
            if (payload && payload.isSystem) {
                console.log(`[Scheduler] Skipping system job '${name}' load (will be ensured later).`);
                continue;
            }

            let callback;
            if (taskType === 'agent_instruction' && payload.task) {
                // Reconstruct agent instruction callback
                callback = async () => {
                    console.log(`[Scheduler] Executing persisted task: ${payload.task} (Retry: ${payload.retryCount || 0})`);

                    const msgSource = payload.targetSource || 'scheduler';
                    const msgMeta = {
                        chatId: payload.targetChatId || `scheduled_${name}_${Date.now()}`
                    };

                    let executionResult = null;
                    try {
                        await this.agent.processMessage({
                            role: 'user',
                            content: `Scheduled Task: ${payload.task}`,
                            source: msgSource,
                            metadata: msgMeta
                        }, async (reply) => {
                            if (this.agent.interface) {
                                await this.agent.interface.send(reply);
                            }
                            // Capture reply for logging
                            if (!executionResult) executionResult = reply;
                            else if (reply.text) executionResult.text = (executionResult.text || '') + '\n' + reply.text;
                        });
                        return executionResult;

                    } catch (error) {
                        console.error(`[Scheduler] Task '${name}' failed:`, error.message);

                        // Retry Logic
                        const currentRetry = payload.retryCount || 0;
                        const MAX_RETRIES = 3;

                        if (currentRetry < MAX_RETRIES) {
                            console.log(`[Scheduler] Rescheduling '${name}' for retry ${currentRetry + 1}/${MAX_RETRIES} in 60s.`);

                            // Re-schedule execution for +1 minute
                            this.scheduleOneOff(name, new Date(Date.now() + 60000), callback, {
                                persist: true,
                                taskType: 'agent_instruction',
                                payload: { ...payload, retryCount: currentRetry + 1 }
                            });
                        } else {
                            console.error(`[Scheduler] Task '${name}' failed permanently after ${MAX_RETRIES} retries.`);

                            // Slack Notification
                            if (process.env.SLACK_WEBHOOK_URL) {
                                try {
                                    await fetch(process.env.SLACK_WEBHOOK_URL, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            text: `🚨 *Task Failure Alert*\n\nThe task *"${payload.task}"* failed after ${MAX_RETRIES} retries.\n\nError: ${error.message}`
                                        })
                                    });
                                } catch (e) { console.error('[Scheduler] Failed to send Slack alert:', e); }
                            }
                        }
                        throw error; // Propagate error so scheduleJob logger sees it
                    }
                };
            } else {
                console.warn(`[Scheduler] Unknown task type '${taskType}' for job '${name}'. Skipping.`);
                continue;
            }

            // Schedule without re-persisting
            this.scheduleJob(name, cronExpression, callback, { persist: false, taskType, payload, expiresAt });
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
            console.log(`[Scheduler] Ensuring system job '${sysJob.name}'...`);

            // Always overwrite/update system jobs to ensure latest logic and metadata
            // This handles cases where old versions exist in DB without proper flags
            if (this.jobs[sysJob.name]) {
                this.cancelJob(sysJob.name);
            }

            // Use the standard scheduleJob logic which handles the callback wrapper
            // We manually construct the instruction wrapper to match 'agent_instruction' type
            const callback = async () => {
                console.log(`[Scheduler] Executing SYSTEM task: ${sysJob.task} `);

                // Direct Execution for Backup (Bypass Agent LLM to avoid context window usage/failures and ensure reliability)
                if (sysJob.name === 'nightly_backup') {
                    let result;
                    try {
                        result = await this.agent.backupManager.performBackup();
                        console.log('[Scheduler] Nightly Backup Result:', result);
                    } catch (err) {
                        console.error('[Scheduler] Nightly Backup Failed:', err);
                        result = { error: err.message };
                        throw err;
                    }
                    return result; // Return for logging
                }

                // Nightly Consolidation + Maintenance
                if (sysJob.name === 'nightly_consolidation') {
                    // Also run log cleanup
                    try {
                        if (this.agent.db) this.agent.db.cleanupJobLogs(30);
                    } catch (e) {
                        console.error('[Scheduler] Log cleanup failed:', e);
                    }
                }

                let executionResult = null;
                await this.agent.processMessage({
                    role: 'user',
                    content: `System Maintenance: ${sysJob.task} `,
                    source: 'scheduler',
                    metadata: { chatId: `system_${sysJob.name}_${Date.now()} ` }
                }, async (reply) => {
                    // Fire and forget response
                    if (this.agent.interface) await this.agent.interface.send(reply);
                    // Capture reply for logging
                    if (!executionResult) executionResult = reply;
                    else if (reply.text) executionResult.text = (executionResult.text || '') + '\n' + reply.text;
                });
                return executionResult; // Return for logging
            };

            this.scheduleJob(sysJob.name, sysJob.cron, callback, {
                persist: true, // Persist so they show up in DB listing if needed, though mostly for consistent ID
                taskType: 'agent_instruction',
                payload: { task: sysJob.task, isSystem: true }
            });
        }
    }

    /**
     * Schedule a one-off reminder.
     */
    scheduleOneOff(name, date, callback, options = {}) {
        this.scheduleJob(name, date, callback, { ...options, oneOff: true });
    }

    /**
     * Manually triggers a job immediately.
     */
    async runJob(name) {
        const job = this.jobs[name];
        if (!job) {
            throw new Error(`Job '${name}' not found.`);
        }
        console.log(`[Scheduler] Manually triggering job: ${name} `);
        // node-schedule jobs rely on the callback passed to scheduleJob.
        // We can access it via job.job which is internal, or just invoke the wrapper if we stored it?
        // node-schedule does not expose the callback cleanly on the job object usually (it's in job.job() but hidden).

        // BETTER APPROACH: invokeJob() is a method on the Job object in node-schedule!
        job.invoke();
        return { success: true };
    }
}

module.exports = { Scheduler };
