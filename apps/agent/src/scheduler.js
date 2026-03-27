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
                            this.agent.interface?.broadcast('joblog:update', { jobName: name, status: 'success' });
                        }
                    } catch (err) {
                        console.error(`[Scheduler] Immediate job '${name}' failed:`, err);
                        if (this.agent.db) {
                            this.agent.db.logJobExecution(name, 'failure', err.message, 0);
                            this.agent.interface?.broadcast('joblog:update', { jobName: name, status: 'failure' });
                        }
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
                this.agent.interface?.broadcast('joblog:update', { jobName: name, status, duration });
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
            expiresAt: options.expiresAt,
            enabled: options.enabled !== false
        }; // cronExpression here might be ISO string

        // Ensure payload is stored in memory for API access
        this.jobs[name].metadata.payload = options.payload || {};
        if (options.oneOff) this.jobs[name].metadata.payload.isOneOff = true;

        if (options.enabled === false) {
            job.cancel();
            console.log(`[Scheduler] Job '${name}' loaded but implicitly paused (enabled: false).`);
        }

        if (options.persist) {
            this.agent.db.saveScheduledJob({
                name,
                cronExpression: typeof cronExpression === 'string' ? cronExpression : cronExpression.toISOString(),
                taskType: options.taskType || 'custom',
                payload: { ...options.payload, isOneOff: !!options.oneOff },
                expiresAt: options.expiresAt,
                enabled: options.enabled !== false
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

    toggleJob(name, enabled) {
        const job = this.jobs[name];
        if (!job) {
            console.error(`[Scheduler] Cannot toggle unknown job: ${name}`);
            return false;
        }

        job.metadata.enabled = !!enabled;

        if (enabled) {
            // Reschedule it to activate it
            const rule = job.metadata.payload?.isOneOff ? new Date(job.metadata.cronExpression) : job.metadata.cronExpression;
            job.reschedule(rule);
        } else {
            job.cancel();
        }

        if (this.agent.db) {
            this.agent.db.saveScheduledJob({
                name,
                cronExpression: typeof job.metadata.cronExpression === 'string' ? job.metadata.cronExpression : job.metadata.cronExpression.toISOString(),
                taskType: job.metadata.payload?.taskType || 'custom',
                payload: job.metadata.payload,
                expiresAt: job.metadata.expiresAt,
                enabled: !!enabled
            });
        }
        console.log(`[Scheduler] Job '${name}' toggled. Enabled: ${!!enabled}`);
        return true;
    }

    async loadJobs() {
        console.log('[Scheduler] Loading persisted jobs...');
        const jobs = this.agent.db.getScheduledJobs();
        for (const jobData of jobs) {
            const { name, cronExpression, taskType, payload, expiresAt, enabled } = jobData;

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
            if (payload && payload.task) {
                // Any job with a task string is treated as an agent instruction
                // (handles legacy 'custom', 'function_call', and 'agent_instruction' types)
                // Reconstruct agent instruction callback
                callback = async () => {
                    console.log(`[Scheduler] Executing persisted task: ${payload.task} (Retry: ${payload.retryCount || 0})`);

                    const msgSource = payload.targetSource || 'scheduler';
                    const msgMeta = {
                        chatId: payload.targetChatId || `scheduled_${name}_${Date.now()}`,
                        jobName: name,
                        ...(payload.model ? { forceModel: payload.model } : {}),
                        ...(payload.allowedTools ? { allowedTools: payload.allowedTools } : {})
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

                        // Process Smart Notification INSIDE the try/catch so errors fail the job.
                        // Skip if the agent already sent directly to a user-facing source
                        // (e.g. whatsapp:assistant), since the callback delivered the message.
                        const alreadyDelivered = msgSource !== 'scheduler';
                        return await this._processSmartNotification(executionResult, payload, alreadyDelivered);

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

            this.scheduleJob(name, cronExpression, callback, {
                persist: false,
                taskType,
                payload,
                expiresAt,
                enabled, // Restore correct memory stat without persisting a DB write immediately
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

                    // 0. Check for error messages — never send raw errors to user
                    if (result && result.text) {
                        const text = result.text;
                        if (text.startsWith('⚠️') || text.includes('exception TypeError') || text.includes('fetch failed') || text.includes('ECONNRESET')) {
                            console.log(`[Scheduler] Smart Notification: Suppressing error notification: ${text.substring(0, 100)}`);
                            result.decision = 'silent';
                            result.decisionReason = 'Error message suppressed';
                            return result;
                        }
                    }

                    // 1. Check for [SILENT] tag from agent (Highest Priority)
                    if (result && result.text) {
                        const text = result.text;

                        if (text.startsWith('[SILENT]') || text.startsWith('[silent]')) {
                            const reasoning = text.replace(/^\[SILENT\]\s*/i, '').trim();
                            console.log(`[Scheduler] Smart Notification: Agent signaled [SILENT]. Suppressing notification.`);
                            console.log(`[Scheduler] Agent reasoning: ${reasoning.substring(0, 200)}`);
                            result.text = reasoning;
                            result.decision = 'silent';
                            result.decisionReason = 'Agent signaled [SILENT]';
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
                        if (result) {
                            result.decision = 'notified';
                            result.decisionReason = `Sent via ${channel}`;
                        }
                        const sendResult = await this.agent.interface.send({
                            source: 'scheduler',
                            content: notificationText,
                            type: 'text',
                            metadata: {
                                chatId: ownerPhone
                            },
                            platform: channel, // Used by server.js to route from scheduler
                            isNotification: true
                        });

                        // If send() explicitly returns false (e.g. HttpInterface swallowed an error)
                        if (sendResult === false) {
                            throw new Error(`Failed to send smart notification to ${channel} for ${ownerPhone}`);
                        }
                    } else {
                        const silentReason = !result?.text ? 'No output text' : `Action=${!!taskLower.match(/^(turn|run|backup)/i)}, Explicit=${!!taskLower.match(/^(remind|alert|notify)/i)}`;
                        console.log(`[Scheduler] Smart Notification: Silent (Reason: ${silentReason})`);
                        if (result) {
                            result.decision = 'silent';
                            result.decisionReason = silentReason;
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[Scheduler] Smart Notification Failed:', err);
            // Rethrow so the scheduler logs a failure and potentially retries, instead of silently passing
            throw err;
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
                cron: '0 7-22 * * *', // Daytime only (7am-10pm), reduced from every hour
                task: `[PROACTIVE LOOP] You have free time. Scan messages from the last 4 hours across all platforms.

Spawn the following sub-agents using spawnAgent. You MUST pass 'lightweight: true' and 'tools' for each one.

1. SLACK sub-agent:
spawnAgent(task: "Scan Slack messages from the last 4 hours. Call readAllMonitoredSlackHistory(days_back: 1). Return only actionable items directed at the owner in format: '[Slack #channel] Person Name: item'. If nothing actionable, return [SILENT].", model: "FLASH", lightweight: true, tools: ["readAllMonitoredSlackHistory", "readSlackHistory", "resolveSlackUser"])

2. WORK EMAIL & CALENDAR sub-agent:
spawnAgent(task: "Scan work Email and Calendar for the last 4 hours. Call work_calendar (events.list on calendarId: 'primary' only) and work_gmail (messages.list for recent messages, read subjects/snippets only). Do NOT call calendarList. Do NOT open individual emails unless the subject suggests an action item. Return only actionable items in format: '[Email] Sender: summary' or '[Calendar] Event: time'. If nothing, return [SILENT].", model: "FLASH", lightweight: true, tools: ["server:gws_work"])

3. PERSONAL EMAIL & CALENDAR sub-agent:
spawnAgent(task: "Scan personal Email and Calendar for the last 4 hours. Call personal_calendar (events.list on calendarId: 'primary' only) and personal_gmail (messages.list for recent messages, read subjects/snippets only). Do NOT call calendarList. Do NOT open individual emails unless the subject suggests an action item. Return only actionable items in format: '[Email] Sender: summary' or '[Calendar] Event: time'. If nothing, return [SILENT].", model: "FLASH", lightweight: true, tools: ["server:gws_personal"])

4. WHATSAPP sub-agent:
spawnAgent(task: "Scan WhatsApp for messages in the last 4 hours. Follow this EXACT procedure:\\n1. Call listConversations(session: 'user', limit: 10) to get the 10 most recent conversations.\\n2. For each conversation with messages in the last 4 hours, call readChatHistory(session: 'user', contact: <contactId from step 1>, limit: 20).\\n3. If readChatHistory returns empty or no recent messages, SKIP that contact and move on.\\n4. HARD LIMIT: 12 tool calls maximum (1 listConversations + up to 10 readChatHistory + 1 buffer).\\n5. Return only actionable items directed at the owner in format: '[WhatsApp] Contact Name: item'.\\n6. If nothing actionable, return [SILENT].", model: "FLASH", lightweight: true, tools: ["listConversations", "readChatHistory"])

AFTER all sub-agents complete, review their results and apply strict filtering:

NOISE FILTER — automatically discard these (do NOT include in your message):
- Security alerts (new sign-in, password change, 2FA notifications)
- Automated notifications (shipping updates, order confirmations, subscription receipts)
- Marketing emails, newsletters, promotional offers
- Calendar invites you've already accepted or declined
- Generic FYI emails not requiring your action
- Routine status reports unless they contain a specific action item for you

ACTIONABLE CRITERIA — only include items where:
1. It requires a response, decision, or action from ME
2. It is NOT a routine/automated notification
Note: Group messages and CC'd items CAN be actionable if they contain something relevant to me — use your judgment.

BE PROACTIVE — You are not just a summarizer. After filtering, take action when appropriate:
- Time-sensitive events (tickets, deadlines, expiring offers): Create a calendar event or reminder so I don't miss it.
- Meeting invites that are important or complex: Add a reminder 30 min before with context about what the meeting is about. Skip routine/recurring meetings.
- Action items with deadlines: Set a reminder — but FIRST check if I've already handled it (search memory/history). Only create the reminder if it's genuinely unresolved.
- Items that need my personal attention: Flag them in the summary with why they're urgent.
Use your judgment. If you can handle something without bothering me, do it. Only message me for things that genuinely need my input.

HARD RULE: NEVER contact anyone on my behalf. Do NOT send messages, emails, or replies to any person. You may only message ME (your owner).

FORMAT RULES (for the summary message, if you send one):
- Each item MUST include its source platform in brackets: [Slack #channel-name], [WhatsApp], [Email], or [Calendar]
- Use FULL contact names as they appear on each platform. Never shorten or alias across platforms.
- Do NOT merge contacts from different platforms even if names look similar.
- Do NOT list tasks already completed, answered, or resolved.
- If you took proactive action on an item, note what you did (e.g., "→ Added to calendar", "→ Set reminder").

INVESTIGATION: If a scanner returns something ambiguous that MIGHT be important but needs more context, you MAY spawn an additional sub-agent to investigate that specific item (e.g., read the full email body). Keep investigation focused — max 2-3 tool calls per investigation.

DECISION:
- If you have 3+ genuinely actionable items, send a summary to your owner.
- If you have 1-2 items, send only if they are time-sensitive (today/tomorrow deadline).
- If you only took silent actions (calendar events, reminders) with nothing urgent, output [SILENT].
- Check if you have already notified the user about this topic recently — do NOT repeat.`,
                silent: false
            }
        ];

        console.log('[Scheduler] Verifying system jobs...');

        const persistedJobs = this.agent.db ? this.agent.db.getScheduledJobs() : [];
        const persistedStates = {};
        persistedJobs.forEach(j => { persistedStates[j.name] = j; });

        for (const sysJob of SYSTEM_JOBS) {
            console.log(`[Scheduler] Ensuring system job '${sysJob.name}'...`);

            // Always overwrite/update system jobs to ensure latest logic and metadata
            // This handles cases where old versions exist in DB without proper flags
            if (this.jobs[sysJob.name]) {
                this.cancelJob(sysJob.name);
            }

            const existing = persistedStates[sysJob.name];
            const isEnabled = existing && 'enabled' in existing ? existing.enabled : true;

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
                        if (this.agent.notifications) {
                            this.agent.notifications.create({
                                type: 'backup_failed',
                                severity: 'error',
                                title: 'Nightly backup failed',
                                message: `The scheduled backup failed: ${err.message}`,
                                metadata: { error: err.message, link: '/system' }
                            });
                        }
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
                    // 20% chance to run each eligible hour (down from 35%)
                    if (Math.random() >= 0.20) {
                        console.log('[Scheduler] Proactive loop skipped this hour (RNG).');
                        return { success: true, skipped: true };
                    }
                    // Random delay 1-30 minutes to avoid predictable timing
                    const delayMinutes = Math.floor(Math.random() * 30) + 1;
                    const delayMs = delayMinutes * 60 * 1000;
                    console.log(`[Scheduler] Proactive loop ACTIVATED this hour! Delaying ${delayMinutes}m before waking Agent...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    console.log('[Scheduler] Proactive loop delay complete. Waking up Agent...');
                }

                let executionResult = null;
                await this.agent.processMessage({
                    role: 'user',
                    content: `System Maintenance: ${sysJob.task} `,
                    source: 'scheduler',
                    metadata: { chatId: `system_${sysJob.name}_${Date.now()}` }
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
                enabled: isEnabled,
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
