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
            if (rule.getTime() <= Date.now()) {
                console.warn(`[Scheduler] One-off job '${name}' is scheduled in the PAST (${rule.toISOString()}). Running IMMEDIATELY.`);

                // Execute immediately
                (async () => {
                    try {
                        console.log(`[Scheduler] Immediate execution of '${name}'...`);
                        const result = await callback();
                        // Log success
                        if (this.agent.db) {
                            let output = result ? (typeof result === 'object' ? JSON.stringify(result) : String(result)) : null;
                            this.agent.db.logJobExecution(name, 'success', output, 0);
                        }
                    } catch (err) {
                        console.error(`[Scheduler] Immediate job '${name}' failed:`, err);
                        if (this.agent.db) this.agent.db.logJobExecution(name, 'failure', err.message, 0);
                    } finally {
                        // Cleanup
                        console.log(`[Scheduler] Immediate job '${name}' completed. Cleaning up...`);
                        delete this.jobs[name];
                        if (this.agent.db) {
                            this.agent.db.deleteScheduledJob(name);
                            this.agent.db.deleteJobState(name);
                        }
                    }
                })();
                return; // SKIP normal scheduling
            }
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
                this.agent.db.deleteJobState(name);
            }
        });

        if (!job) {
            console.error(`[Scheduler] Failed to schedule job '${name}'. Rule: ${rule}`);
            return;
        }

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
            this.agent.db.deleteJobState(name);
            console.log(`[Scheduler] Job '${name}' cancelled, removed from DB, and state cleaned.`);
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
                    this.agent.db.deleteJobState(name);
                    continue;
                }
            }

            // One-Off Past Check (Filter out old reminders that we missed)
            const isOneOff = payload?.isOneOff || false; // Trust payload flag
            if (isOneOff) {
                const jobTime = new Date(cronExpression).getTime();
                if (jobTime <= Date.now()) {
                    console.log(`[Scheduler] Found past one-off job '${name}' during load (${cronExpression}). Filtering/Deleting.`);
                    this.agent.db.deleteScheduledJob(name);
                    this.agent.db.deleteJobState(name);
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
                        chatId: payload.targetChatId || `scheduled_${name}_${Date.now()}`,
                        jobName: name
                    };

                    let executionResult = null;
                    try {
                        await this.agent.processMessage({
                            role: 'user',
                            content: `Scheduled Task: ${payload.task}\n\n[SYSTEM: This is a recurring job. To track changes between runs, use 'getJobState' to check previous data and 'saveJobState' to save new data. IMPORTANT: If the result of this task is "nothing to report" or "no action needed", prefix your ENTIRE response with the tag [SILENT] (e.g. "[SILENT] No commitments found."). This prevents unnecessary notifications to the user. Only omit [SILENT] when you have genuinely actionable or interesting information to share.]`,
                            source: msgSource,
                            metadata: msgMeta
                        }, async (reply) => {
                            if (this.agent.interface) {
                                await this.agent.interface.send(reply);
                            }
                            // Capture reply for logging
                            if (!executionResult) {
                                executionResult = reply;
                            } else if (reply.content) {
                                executionResult.text = (executionResult.text || '') + '\n' + reply.content;
                            }
                            // Always ensure the latest text is tracked
                            if (reply.content) executionResult.text = reply.content;
                        });

                        // Ensure result has a string text property
                        if (!executionResult) executionResult = { text: '' };
                        if (typeof executionResult.text !== 'string') executionResult.text = String(executionResult.content || executionResult.text || '');

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

            // We need to wrap the callback to include smart notification logic if it's an agent instruction
            if (taskType === 'agent_instruction' && payload.task) {
                const originalCallback = callback;
                callback = async () => {
                    const result = await originalCallback();
                    return await this._processSmartNotification(result, payload);
                };
            }


            this.scheduleJob(name, cronExpression, callback, {
                persist: false,
                taskType,
                payload,
                expiresAt,
                oneOff: isOneOff // IMPORTANT: Pass this so scheduleJob handles it as Date object
            });
        }
        console.log(`[Scheduler] Loaded ${Object.keys(this.jobs).length} jobs from DB.`);
    }

    async _processSmartNotification(result, payload, forceSilent = false) {
        if (forceSilent) return result;

        try {
            if (this.agent.interface && this.agent.settings) {
                // Refresh settings directly from DB just to be safe
                const settings = this.agent.db.getAllAgentSettings();
                const ownerPhone = settings.owner_phone;
                const channel = settings.notification_channel || 'whatsapp';

                console.log(`[Scheduler] Smart Notification Evaluation - Phone: ${ownerPhone ? ownerPhone : 'MISSING'}, Channel: ${channel}`);

                if (ownerPhone) {
                    const taskLower = (payload.task || '').toLowerCase();
                    let shouldNotify = false;
                    let notificationText = null;

                    // 0. Check for [SILENT] tag from agent (Highest Priority)
                    if (result && result.text) {
                        const text = result.text;

                        if (text.startsWith('[SILENT]') || text.startsWith('[silent]')) {
                            console.log(`[Scheduler] Smart Notification: Agent signaled [SILENT]. Suppressing notification.`);
                            result.text = text.replace(/^\[SILENT\]\s*/i, '').trim();
                            return result;
                        }
                    }

                    // 1. Check Explicit Instructions (High Priority)
                    if (taskLower.startsWith('remind') || taskLower.startsWith('alert') || taskLower.startsWith('notify') || taskLower.startsWith('tell me')) {
                        shouldNotify = true;
                    }

                    // 2. Check Output Content (Medium Priority)
                    if (result && result.text) {
                        const text = result.text;
                        const textLower = text.toLowerCase();

                        if (textLower.includes('diego,') || textLower.includes('alert:') || textLower.includes('warning:')) {
                            shouldNotify = true;
                        }

                        const isAction = taskLower.match(/^(turn|run|backup)/i) !== null;

                        // If it's NOT an action and we haven't decided it's NOT worthy yet, we notify by default.
                        // Actions are quiet by default unless explicitly asked to alert.
                        if (!shouldNotify && !isAction) {
                            shouldNotify = true;
                        }

                        console.log(`[Scheduler] Evaluated Output Content: isAction=${isAction}, shouldNotify=${shouldNotify}`);

                        notificationText = text;
                    }

                    if (shouldNotify && notificationText) {
                        console.log(`[Scheduler] Smart Notification: Pushing to ${channel}...`);
                        await this.agent.interface.send({
                            to: ownerPhone,
                            platform: channel,
                            content: notificationText,
                            isNotification: true
                        });
                    } else {
                        console.log(`[Scheduler] Smart Notification: Silent (Reason: Action=${!!taskLower.match(/^(turn|run|backup)/i)}, Explicit=${!!taskLower.match(/^(remind|alert|notify)/i)})`);
                    }
                }
            }
        } catch (err) {
            console.error('[Scheduler] Smart Notification Failed:', err);
        }

        return result;
    }

    /**
     * Ensures critical system jobs exist.
     */
    ensureSystemJobs() {
        const SYSTEM_JOBS = [
            {
                name: 'nightly_consolidation',
                cron: '0 0 * * *', // Midnight
                task: 'Run consolidateMemory tool to summarize yesterday\'s logs into the journal.',
                silent: true
            },
            {
                name: 'nightly_backup',
                cron: '0 2 * * *', // 2 AM
                task: 'Perform nightly backup of data to GCS.',
                silent: true
            },
            {
                name: 'nightly_rag_scan',
                cron: '0 3 * * *', // 3 AM
                task: 'Scan vaults and ingest missing files into RAG.',
                silent: true
            },
            {
                name: 'nightly_memory_pruning',
                cron: '0 4 * * *', // 4 AM
                task: 'Prune stale or obsolete facts from memory.',
                silent: true
            },
            {
                name: 'nightly_dream',
                cron: '30 4 * * *', // 4:30 AM
                task: 'Enter REM sleep and dream based on recent memories and Plex activity.',
                silent: true
            },
            {
                name: 'proactive_thought',
                cron: '0 * * * *', // Every hour
                task: `[PROACTIVE LOOP] You have free time. Review your recent context, including latest chats and WhatsApp messages. If you want to do background research based on them, do it. If you want to talk to your owner, output a message. IMPORTANT: Check the current time. If it is late at night/sleeping hours, DO NOT output a message (use [SILENT] instead) to avoid waking the user up for non-critical things. Additionally, check if you have already notified the user about a topic recently; DO NOT repeat yourself. Otherwise, output ONLY [SILENT] if no action is needed. DO NOT message third parties.`,
                silent: false
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

                // Nightly RAG Scan
                if (sysJob.name === 'nightly_rag_scan') {
                    if (this.agent.ragService && this.agent.vaults) {
                        try {
                            console.log('[Scheduler] Starting Nightly RAG Scan...');
                            await this.agent.ragService.scanAndIngest(this.agent.vaults.vaultsDir);

                            // Also scan and embed journal entries
                            if (this.agent.journal) {
                                await this.agent.ragService.scanJournals(this.agent.journal.journalDir);
                            }

                            return { success: true };
                        } catch (e) {
                            console.error('[Scheduler] RAG Scan Failed:', e);
                            throw e;
                        }
                    } else {
                        return { error: 'RAG Service or Vaults not available' };
                    }
                }

                // Nightly Memory Pruning
                if (sysJob.name === 'nightly_memory_pruning') {
                    if (this.agent.memoryPruning) {
                        try {
                            console.log('[Scheduler] Starting Nightly Memory Pruning...');
                            const result = await this.agent.memoryPruning.prune();
                            return result;
                        } catch (e) {
                            console.error('[Scheduler] Memory Pruning Failed:', e);
                            throw e;
                        }
                    } else {
                        return { error: 'MemoryPruning Service not available' };
                    }
                }

                // Nightly Dreaming
                if (sysJob.name === 'nightly_dream') {
                    if (this.agent.dreamService) {
                        console.log('[Scheduler] Agent is entering REM sleep...');
                        try {
                            const result = await this.agent.dreamService.dream();
                            return result;
                        } catch (error) {
                            console.error('[Scheduler] Nightly dream failed:', error);
                            throw error;
                        }
                    } else {
                        return { error: 'DreamService not available' };
                    }
                }

                // Nightly Consolidation + Maintenance
                if (sysJob.name === 'nightly_consolidation') {
                    // Also run log cleanup
                    try {
                        if (this.agent.db) {
                            this.agent.db.cleanupJobLogs(30);
                            this.agent.db.cleanupMetrics(30);
                            this.agent.db.cleanupTokenUsage(30);
                        }
                    } catch (e) {
                        console.error('[Scheduler] Log cleanup failed:', e);
                    }
                }

                // Proactive Thought (Probabilistic execution)
                if (sysJob.name === 'proactive_thought') {
                    // 20% chance to run every hour
                    if (Math.random() >= 0.20) {
                        console.log('[Scheduler] Proactive loop skipped this hour (RNG).');
                        return { success: true, skipped: true };
                    }
                    console.log('[Scheduler] Proactive loop ACTIVATED this hour! Waking up Agent...');
                }

                let executionResult = null;
                await this.agent.processMessage({
                    role: 'user',
                    content: `System Maintenance: ${sysJob.task} `,
                    source: 'scheduler',
                    metadata: { chatId: `system_${sysJob.name}_${Date.now()} ` }
                }, async (reply) => {
                    // Update executionResult as the stream progresses, storing the latest full text
                    // reply can be { text: '...', toolCalls: [...] }. We care about the final text.
                    if (!executionResult) {
                        executionResult = reply;
                    } else if (reply.text) {
                        executionResult.text = (executionResult.text || '') + '\n' + reply.text;
                    } else if (reply.toolCall) {
                        // ignore intermediate tool call markers from updating text
                    }
                });

                // Now safely pass the final result through the Notification Logic!
                return await this._processSmartNotification(executionResult, { task: sysJob.task }, sysJob.silent);
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

    /**
     * Stops all scheduled jobs.
     */
    async stop() {
        console.log('[Scheduler] Stopping all jobs...');
        for (const name in this.jobs) {
            this.jobs[name].cancel(); // Cancel in memory only, preserve in DB
        }
        this.jobs = {};
        // node-schedule graceful shutdown
        await schedule.gracefulShutdown();
    }
}

module.exports = { Scheduler };
