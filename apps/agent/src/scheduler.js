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
                            // Capture reply for smart notification.
                            // createAssistantMessage uses 'content', not 'text'.
                            const replyText = reply.content || reply.text;
                            if (!executionResult) {
                                executionResult = reply;
                                if (replyText) executionResult.text = replyText;
                            } else if (replyText) {
                                // Always keep the latest text — final assistant message overwrites intermediate "Thinking..." messages
                                executionResult.text = replyText;
                            }
                        });

                        // Ensure result has text for smart notification
                        if (!executionResult) executionResult = { text: '' };
                        if (!executionResult.text) {
                            executionResult.text = String(executionResult.content || '');
                        }

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
                        try {
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
                                console.error(`[Scheduler] Smart Notification delivery failed (${channel} → ${ownerPhone}). Falling back to system notification.`);
                                this._createFallbackNotification(payload, notificationText, `${channel} send returned false`);
                                if (result) {
                                    result.decision = 'delivery_failed';
                                    result.decisionReason = `${channel} send returned false — saved as system notification`;
                                }
                            }
                        } catch (sendErr) {
                            // Notification delivery failure should NOT trigger a full job retry.
                            // The agent already completed its work — only the delivery channel failed.
                            console.error(`[Scheduler] Smart Notification send error (${channel}): ${sendErr.message}. Falling back to system notification.`);
                            this._createFallbackNotification(payload, notificationText, sendErr.message);
                            if (result) {
                                result.decision = 'delivery_failed';
                                result.decisionReason = `${sendErr.message} — saved as system notification`;
                            }
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
     * Create a system notification when message delivery fails.
     * The notification will appear in the web dashboard so the owner doesn't miss it.
     */
    _createFallbackNotification(payload, messageText, errorReason) {
        try {
            if (!this.agent.db) return;

            const crypto = require('crypto');
            const jobName = payload?.task ? payload.task.substring(0, 50) : 'Unknown job';
            this.agent.db.createNotification({
                id: crypto.randomUUID(),
                type: 'delivery_failure',
                severity: 'warning',
                title: `📬 Undelivered notification`,
                message: messageText.length > 2000 ? messageText.substring(0, 2000) + '...' : messageText,
                metadata: { jobName, errorReason }
            });
            console.log(`[Scheduler] Fallback notification created for failed delivery (${jobName}).`);
            this.agent.interface?.broadcast('notification:new', { type: 'delivery_failure' });
        } catch (err) {
            console.error('[Scheduler] Failed to create fallback notification:', err.message);
        }
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

PHASE 1 — SCAN (use lightweight FLASH sub-agents):

Spawn these sub-agents. You MUST pass 'lightweight: true' and 'tools' for each one.

1. SLACK:
spawnAgent(task: "Scan Slack from the last 4 hours. Call readAllMonitoredSlackHistory(days_back: 1). Return actionable items in format: '[Slack #channel] Person: item'. If nothing, return [SILENT].", model: "FLASH", lightweight: true, tools: ["readAllMonitoredSlackHistory", "readSlackHistory", "resolveSlackUser"])

2. WORK EMAIL & CALENDAR:
spawnAgent(task: "Scan work Email/Calendar last 4 hours. Call work_gmail messages.list (maxResults: 15, read subjects/snippets ONLY). Call work_calendar events.list (calendarId: 'primary'). Do NOT open individual emails. HARD LIMIT: 8 tool calls. Return items in format: '[Email] Sender: subject' or '[Calendar] Event: time'. If nothing, return [SILENT].", model: "FLASH", lightweight: true, tools: ["server:gws_work"])

3. PERSONAL EMAIL & CALENDAR:
spawnAgent(task: "Scan personal Email/Calendar last 4 hours. Call personal_gmail messages.list (maxResults: 15, read subjects/snippets ONLY). Call personal_calendar events.list (calendarId: 'primary'). Do NOT open individual emails. HARD LIMIT: 8 tool calls. Return items in format: '[Email] Sender: subject' or '[Calendar] Event: time'. If nothing, return [SILENT].", model: "FLASH", lightweight: true, tools: ["server:gws_personal"])

4. WHATSAPP:
spawnAgent(task: "Scan WhatsApp last 4 hours.\\n1. listConversations(session: 'user', limit: 10).\\n2. For each with recent messages, readChatHistory(session: 'user', contact: <id>, limit: 20).\\n3. Skip empty conversations.\\n4. HARD LIMIT: 12 tool calls.\\n5. Return items in format: '[WhatsApp] Contact: item'. If nothing, return [SILENT].", model: "FLASH", lightweight: true, tools: ["listConversations", "readChatHistory"])

PHASE 2 — FILTER (apply your judgment as a PRO model):

DISCARD — never include these:
- Security alerts, 2FA, password notifications
- Shipping updates, order confirmations, subscription receipts
- Marketing emails, newsletters, promotional offers, program applications
- Calendar invites already accepted/declined
- Generic FYI emails, routine status reports
- Anything the owner was CC'd on that doesn't require their direct action

KEEP — only items where:
- A real person (not an automated system) is asking the owner to do something
- There's a decision, response, or action only the owner can take
- There's a time-sensitive situation the owner should know about TODAY

PHASE 3 — THINK (this is what makes you valuable):

You are not a notification relay. You are an intelligent assistant. After filtering, THINK about what you found:

- If a colleague is asking for something and you know the answer from memory/facts, consider whether the owner needs to be involved at all. If not, skip it.
- If there's a meeting coming up in the next 2 hours that looks important or complex, set a reminder with context (but ONLY for meetings that are unusual — skip daily standups, recurring 1:1s, and routine syncs).
- If you see a pattern (e.g., someone has asked the owner the same thing multiple times), flag that specifically.
- If an item needs investigation to determine if it's actionable, you MAY spawn a focused sub-agent to read the full email body or check context. Max 3 tool calls per investigation.

DO NOT:
- Set reminders for promotional emails or marketing deadlines
- Set reminders for routine/recurring meetings
- Create goals or reminders unless you've checked (via searchMemory) that the owner hasn't already handled it
- NEVER contact anyone on the owner's behalf — do NOT send messages, emails, or replies to any person. You may only message the OWNER.

PHASE 4 — DECIDE:

- If you have genuinely important items that need the owner's attention TODAY → send a concise summary
- If you only have low-priority items → output [SILENT] (the daily_commitments job will catch these later)
- If you took a silent action (e.g., set a useful reminder) but nothing needs the owner's attention → output [SILENT]
- Check memory: have you already notified the owner about this topic recently? If yes → [SILENT]

FORMAT (when you do notify):
- Each item: [Platform #context] Person Name: what they need from you
- If you took action: append "→ Set reminder" or "→ Added to calendar"
- Be concise. 3-5 bullets max. No essays.`,
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
                    // Capture reply for smart notification.
                    // createAssistantMessage uses 'content', not 'text'.
                    const replyText = reply.content || reply.text;
                    if (!executionResult) {
                        executionResult = reply;
                        if (replyText) executionResult.text = replyText;
                    } else if (replyText) {
                        // Always keep the latest text — final assistant message overwrites intermediate "Thinking..." messages
                        executionResult.text = replyText;
                    }
                });

                // Ensure result has text for smart notification
                if (executionResult && !executionResult.text) {
                    executionResult.text = String(executionResult.content || '');
                }

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
