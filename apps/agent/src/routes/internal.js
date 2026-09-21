const express = require('express');
const { taintFromPayload } = require('../utils/untrusted-content');
const fs = require('fs');
const path = require('path');
const browserSecrets = require('../utils/browser-secrets');

function createInternalRouter(agent) {
    const router = express.Router();

    // Middleware to check agent readiness
    router.use((req, res, next) => {
        if (!agent) return res.status(503).json({ error: 'Agent not initialized' });
        next();
    });

    // --- Journal ---
    router.get('/journal', (req, res) => {
        if (!agent.journal) return res.status(503).json({ error: 'Journal not ready' });
        try {
            const files = fs.readdirSync(agent.journal.journalDir)
                .filter(f => f.endsWith('.md'))
                .sort().reverse();
            res.json({ files });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/journal/:date', (req, res) => {
        if (!agent.journal) return res.status(503).json({ error: 'Journal not ready' });
        try {
            const { date } = req.params;
            const filename = date.endsWith('.md') ? date : `${date}.md`;
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
                return res.status(400).json({ error: 'Invalid filename' });
            }
            const filePath = path.join(agent.journal.journalDir, filename);
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Journal not found' });
            const content = fs.readFileSync(filePath, 'utf8');
            res.json({ date, content });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put('/journal/:date', (req, res) => {
        if (!agent.journal) return res.status(503).json({ error: 'Journal not ready' });
        try {
            const { date } = req.params;
            const { content } = req.body;
            if (!content) return res.status(400).json({ error: 'Content required' });

            const filename = date.endsWith('.md') ? date : `${date}.md`;
            // Security: Prevent Directory Traversal
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
                return res.status(400).json({ error: 'Invalid filename' });
            }

            const filePath = path.join(agent.journal.journalDir, filename);
            const resolvedPath = path.resolve(filePath);
            const resolvedJournalDir = path.resolve(agent.journal.journalDir);
            if (!resolvedPath.startsWith(resolvedJournalDir)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            fs.writeFileSync(filePath, content, 'utf8');
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete('/journal/:date', (req, res) => {
        if (!agent.journal) return res.status(503).json({ error: 'Journal not ready' });
        try {
            const { date } = req.params;
            const filename = date.endsWith('.md') ? date : `${date}.md`;
            if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return res.status(400).json({ error: 'Invalid filename' });
            const filePath = path.join(agent.journal.journalDir, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                res.json({ success: true });
            } else {
                res.status(404).json({ error: 'File not found' });
            }
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Facts ---
    router.get('/facts', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const allFacts = agent.db.getAllFacts();
            // Filter out internal/system keys from user-facing views
            const facts = allFacts.filter(f =>
                !f.key.startsWith('config:') &&
                !f.key.startsWith('job:') &&
                !f.key.startsWith('sys_') &&
                !f.key.startsWith('sch_')
            );
            res.json({ facts });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/facts', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { key, value, category, confidence, source, pinned } = req.body;
            agent.db.setKey(key, value, { category, confidence, source });
            if (pinned !== undefined) {
                agent.db.toggleFactPin(key, pinned);
            }
            if (agent.interface) {
                agent.interface.broadcast('facts:update', { action: 'upsert', key }).catch(() => {});
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/facts/:key/pin', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { pinned } = req.body;
            agent.db.toggleFactPin(req.params.key, pinned);
            if (agent.interface) {
                agent.interface.broadcast('facts:update', { action: 'pin', key: req.params.key, pinned }).catch(() => {});
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete('/facts/:key', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            agent.db.deleteFact(req.params.key);
            if (agent.interface) {
                agent.interface.broadcast('facts:update', { action: 'delete', key: req.params.key }).catch(() => {});
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Tasks / Scheduler ---
    router.get('/tasks', (req, res) => {
        if (!agent.scheduler) return res.status(503).json({ error: 'Scheduler not ready' });
        try {
            const jobs = Object.values(agent.scheduler.jobs)
                .filter(j => {
                    if (req.query.includeSystem === 'true') return true;
                    return !j.metadata?.payload?.isSystem;
                }) // Hide system jobs unless requested
                .map(j => ({
                    name: j.metadata?.name || 'unknown',
                    cron: j.metadata?.cronExpression || 'unknown',
                    task: j.metadata?.payload?.task || '',
                    isSystem: j.metadata?.payload?.isSystem || false,
                    // A system job that runs its work directly takes no model
                    // and no tools, so the UI offers no scope editor for it.
                    scopable: j.metadata?.payload?.scopable !== false,
                    isOneOff: j.metadata?.payload?.isOneOff || false,
                    enabled: j.metadata?.enabled !== false,
                    expiresAt: j.metadata?.expiresAt || null,
                    nextInvocation: j.nextInvocation(),
                    model: j.metadata?.payload?.model || j.metadata?.payload?.scope?.model || 'auto',
                    allowedTools: j.metadata?.payload?.allowedTools || j.metadata?.payload?.scope?.allowedTools || null,
                    // What the code ships with, so the UI can mark an owner
                    // edit as an override and offer to clear it.
                    scopeDefaults: {
                        model: j.metadata?.payload?.scope?.model || null,
                        allowedTools: j.metadata?.payload?.scope?.allowedTools || null
                    },
                    scopeOverride: {
                        model: j.metadata?.payload?.model || null,
                        allowedTools: j.metadata?.payload?.allowedTools || null
                    },
                    weekdaysOnly: j.metadata?.payload?.weekdaysOnly || false,
                    daytimeOnly: j.metadata?.payload?.daytimeOnly || false
                }));
            res.json({ jobs });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/tasks/:id/cancel', (req, res) => {
        if (!agent.scheduler) return res.status(503).json({ error: 'Scheduler not ready' });
        try {
            const { id } = req.params;
            const job = agent.scheduler.jobs[id];
            if (job && job.metadata?.payload?.isSystem) {
                return res.status(403).json({ error: 'Cannot cancel system jobs' });
            }
            agent.scheduler.cancelJob(id);

            if (agent.interface) {
                agent.interface.broadcast('jobs:update', { action: 'cancel', id });
            }

            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/tasks/:id/toggle', (req, res) => {
        if (!agent.scheduler) return res.status(503).json({ error: 'Scheduler not ready' });
        try {
            const { id } = req.params;
            const { enabled } = req.body;

            const success = agent.scheduler.toggleJob(id, enabled);
            if (!success) {
                return res.status(404).json({ error: 'Job not found or failed to toggle' });
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Owner edit of a system job's scope: which model it runs on and which
    // tools it may call. The values land in the persisted payload, which is
    // what Scheduler._systemJobOverrides reads on the next run.
    const SCOPE_MODELS = ['FLASH', 'LITE', 'PRO'];

    router.patch('/tasks/:id/scope', (req, res) => {
        if (!agent.scheduler) return res.status(503).json({ error: 'Scheduler not ready' });
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { id } = req.params;
            const job = agent.scheduler.jobs[id];
            if (!job) return res.status(404).json({ error: 'Job not found' });
            if (!job.metadata?.payload?.isSystem) {
                return res.status(400).json({ error: 'Only system jobs are edited here. Use the task form for your own jobs.' });
            }
            if (job.metadata.payload.scopable === false) {
                return res.status(400).json({ error: 'This job does its work directly, without a model call, so a model and a tool list would change nothing.' });
            }

            const body = req.body || {};
            const payload = { ...(job.metadata.payload || {}) };

            // 'auto', null or '' clears the override and puts the job back on
            // its built-in default.
            if ('model' in body) {
                const raw = body.model;
                if (raw === null || raw === '' || raw === 'auto') {
                    delete payload.model;
                } else if (typeof raw === 'string' && SCOPE_MODELS.includes(raw.toUpperCase())) {
                    payload.model = raw.toUpperCase();
                } else {
                    return res.status(400).json({ error: 'model must be auto, FLASH, LITE or PRO' });
                }
            }

            if ('allowedTools' in body) {
                const raw = body.allowedTools;
                if (raw === null || (Array.isArray(raw) && raw.length === 0)) {
                    delete payload.allowedTools;
                } else if (Array.isArray(raw) && raw.every(t => typeof t === 'string' && t.trim())) {
                    payload.allowedTools = raw.map(t => t.trim());
                } else {
                    return res.status(400).json({ error: 'allowedTools must be an array of tool names' });
                }
            }

            const cronExpression = typeof job.metadata.cronExpression === 'string'
                ? job.metadata.cronExpression
                : new Date(job.metadata.cronExpression).toISOString();

            agent.db.saveScheduledJob({
                name: id,
                cronExpression,
                taskType: job.metadata.payload?.taskType || 'agent_instruction',
                payload,
                expiresAt: job.metadata.expiresAt || null,
                enabled: job.metadata.enabled !== false
            });
            job.metadata.payload = payload;

            // Rebuild the job so the next run reads the new scope.
            agent.scheduler.reregisterSystemJob(id);

            if (agent.interface) {
                agent.interface.broadcast('jobs:update', { action: 'scope', name: id });
            }

            res.json({
                success: true,
                model: payload.model || 'auto',
                allowedTools: payload.allowedTools || null
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/tasks/:id/run', async (req, res) => {
        if (!agent.scheduler) return res.status(503).json({ error: 'Scheduler not ready' });
        try {
            const { id } = req.params;
            await agent.scheduler.runJob(id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/scheduler', async (req, res) => {
        if (!agent.scheduler) return res.status(503).json({ error: 'Scheduler not ready' });
        try {
            const { name, cron, task, expiresAt, isOneOff, model, weekdaysOnly, daytimeOnly } = req.body;
            const existingJob = agent.scheduler.jobs[name];
            if (existingJob && existingJob.metadata?.payload?.isSystem) {
                return res.status(403).json({ error: 'Cannot modify system jobs' });
            }

            // Auto-scope tools for this job prompt
            let allowedTools = null;
            try {
                if (agent.toolScoper) {
                    const mcpTools = await agent.mcp.getTools();
                    allowedTools = await agent.toolScoper.scope(task, mcpTools);
                    console.log(`[Scheduler] Auto-scoped ${allowedTools?.length || 0} tools for job '${name}'`);
                }
            } catch (e) {
                console.warn(`[Scheduler] Tool scoping failed for '${name}', falling back to all tools:`, e.message);
            }

            // A job a tainted run created stays tainted while its task text is
            // unchanged. Rewriting the task is the owner's own instruction.
            const prev = existingJob?.metadata?.payload;
            const keepTaint = prev && prev.tainted === true && prev.task === task
                ? { tainted: true, ...(Array.isArray(prev.taintSources) ? { taintSources: prev.taintSources } : {}) }
                : {};
            const payload = {
                task,
                ...keepTaint,
                ...(model && model !== 'auto' ? { model: model.toUpperCase() } : {}),
                ...(allowedTools ? { allowedTools } : {}),
                ...(weekdaysOnly ? { weekdaysOnly: true } : {}),
                ...(daytimeOnly ? { daytimeOnly: true } : {})
            };

            const callback = async () => {
                console.log(`[Scheduler] Executing task: ${task}`);
                let executionResult = null;
                await agent.processMessage({
                    role: 'user',
                    content: `Scheduled Task: ${task}`,
                    source: 'scheduler',
                    metadata: {
                        chatId: `scheduled_${name}_${Date.now()}`,
                        // As the callback built at boot sets it: job state tools and the refusal metric read it.
                        jobName: name,
                        ...(payload.tainted ? { untrustedTaint: taintFromPayload(payload, `job "${name}"`) } : {}),
                        ...(payload.model ? { forceModel: payload.model } : {}),
                        ...(payload.allowedTools ? { allowedTools: payload.allowedTools } : {})
                    }
                }, async (reply) => {
                    let sent;
                    if (agent.interface) {
                        sent = await agent.interface.send(reply);
                    }
                    if (!executionResult) executionResult = reply;
                    else if (reply.text) executionResult.text = (executionResult.text || '') + '\n' + reply.text;
                    // A false from the interface lets _deliverReply record the failure.
                    return sent;
                });
                return executionResult;
            };

            agent.scheduler.scheduleJob(name, cron, callback, {
                persist: true,
                taskType: 'agent_instruction',
                payload,
                expiresAt: expiresAt || null,
                oneOff: !!isOneOff
            });

            if (agent.interface) {
                agent.interface.broadcast('jobs:update', { action: 'create', name });
            }

            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Stats ---
    // Validate ISO date strings and convert UTC → localtime format for SQLite comparison.
    // DB stores timestamps as 'YYYY-MM-DD HH:MM:SS' in localtime (no T, no Z).
    // Frontend sends ISO 8601 UTC strings like '2026-03-25T03:00:00.000Z'.
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/;
    const safeDate = (v) => {
        if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return undefined;
        // Convert to localtime 'YYYY-MM-DD HH:MM:SS' format matching DB storage
        const d = new Date(v);
        if (isNaN(d.getTime())) return undefined;
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    router.get('/stats', (req, res) => {
        if (!agent.db || !agent.journal) return res.status(503).json({ error: 'Stats dependencies not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const dbStats = agent.db.getStats();
            const journalStats = agent.journal.getStats(start, end);
            const latencyStats = agent.db.getLatencyStats(start, end);
            const contextStats = agent.smartContext.getStats();
            const ragStats = agent.ragService ? agent.ragService.getStats() : {};

            res.json({
                ...dbStats,
                journal: journalStats,
                latency: latencyStats,
                smartContext: contextStats,
                rag: ragStats
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/cleanup', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            agent.db.clearMetrics();
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/latency', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const trend = agent.db.getLatencyTrend(parseInt(req.query.limit || '100', 10), start, end);
            res.json(trend);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/usage', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const usage = agent.db.getTokenUsageStats(start, end);
            res.json(usage);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/cost-trend', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const limit = parseInt(req.query.limit || '100', 10);
            const trend = agent.db.getTokenUsageTrend(limit, start, end);
            res.json(trend);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/daily-cost', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const limit = parseInt(req.query.limit || '90', 10);
            const trend = agent.db.getDailyCostTrend(start, end, limit);
            res.json(trend);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/cost-by-tag', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const days = Math.max(1, Math.min(parseInt(req.query.days || '1', 10) || 1, 365));
            const result = agent.db.getCostByTag(start, end, days);
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // #233 columns: what fills the prompt, the tag as written, and how often
    // the cached prefix moves.
    router.get('/stats/prompt-composition', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const days = Math.max(1, Math.min(parseInt(req.query.days || '7', 10) || 7, 365));
            res.json(agent.db.getPromptComposition(start, end, days));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/cost-by-raw-tag', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const days = Math.max(1, Math.min(parseInt(req.query.days || '7', 10) || 7, 365));
            res.json(agent.db.getCostByRawTag(start, end, days));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/prefix-churn', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const days = Math.max(1, Math.min(parseInt(req.query.days || '7', 10) || 7, 365));
            res.json(agent.db.getPrefixChurn(start, end, days));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/daily-cost-by-category', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const limit = Math.max(1, Math.min(parseInt(req.query.limit || '90', 10) || 90, 365));
            const result = agent.db.getDailyCostByCategory(start, end, limit);
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/cost-by-model', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const days = Math.max(1, Math.min(parseInt(req.query.days || '1', 10) || 1, 365));
            const result = agent.db.getCostByModel(start, end, days);
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/latency-percentiles', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            res.json(agent.db.getLatencyPercentiles(start, end));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/token-breakdown', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            res.json(agent.db.getTokenBreakdownTrend(start, end));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/cache-hit-rate', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            res.json(agent.db.getCacheHitRateTrend(start, end));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/model-usage', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const start = safeDate(req.query.start), end = safeDate(req.query.end);
            const limit = Math.max(1, Math.min(parseInt(req.query.limit || '90', 10) || 90, 365));
            res.json(agent.db.getModelUsageDistribution(start, end, limit));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Sessions / History ---
    router.get('/sessions', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;

            // CLEANUP: Remove empty sessions if user is navigating around
            // If preserveId is sent, we aggressively delete other empty sessions.
            if (agent.db.deleteEmptySessions) {
                agent.db.deleteEmptySessions(req.query.preserveId);
            }

            const sessions = agent.db.getSessions({ limit, offset });
            res.json({ sessions });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/sessions', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { id, title, reuseEmpty } = req.body;
            if (reuseEmpty) {
                const existing = agent.db.getLatestEmptySession();
                // Only reuse if it's NOT a WhatsApp session (no @ symbol or encoded %40)
                // This ensures we get a clean UUID session for the web
                if (existing && !existing.id.includes('@') && !existing.id.includes('%40')) {
                    console.log(`[Agent] Reusing empty session ${existing.id}`);
                    return res.json(existing);
                }
            }
            const session = agent.db.createSession({ id, title });
            res.json(session);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/sessions/:id', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const session = agent.db.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const history = agent.db.getHistory({ chatId: req.params.id, limit: 100 });
            session.messages = history.reverse(); // Standard chat order: Oldest -> Newest
            res.json(session);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put('/sessions/:id', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { title, isArchived, isPinned } = req.body;
            agent.db.updateSession(req.params.id, { title, isArchived, isPinned });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete('/sessions/:id', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            agent.db.deleteSession(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/history', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const limit = parseInt(req.query.limit) || 100;
            const chatId = req.query.chatId;
            const history = agent.db.getHistory({
                limit,
                since: req.query.since,
                until: req.query.until,
                chatId,
                order: req.query.order || 'DESC',
                source: req.query.source
            });

            // If chatId is a subagent, include subagent metadata
            let subagent = null;
            if (chatId && chatId.startsWith('subagent-')) {
                const taskId = chatId.replace('subagent-', '');
                subagent = agent.db.getSubAgent(taskId);
            }

            res.json({ history, subagent });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete('/history/:id', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            agent.db.deleteMessage(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/history/rewind', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { chatId, messageId } = req.body;
            if (!chatId || !messageId) return res.status(400).json({ error: 'Missing chatId or messageId' });

            const count = agent.db.deleteMessagesFrom(chatId, messageId);
            res.json({ success: true, count });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/history/fork', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { chatId, messageId } = req.body;
            if (!chatId || !messageId) return res.status(400).json({ error: 'Missing chatId or messageId' });

            const newSessionId = agent.db.forkSession(chatId, messageId);
            res.json({ success: true, newSessionId });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/chat/stop', (req, res) => {
        try {
            const { chatId } = req.body;
            if (agent.stopGeneration) {
                agent.stopGeneration(chatId);
                res.json({ success: true });
            } else {
                res.status(501).json({ error: 'Stop functionality not implemented' });
            }
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Summaries ---
    router.get('/summaries', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const limit = parseInt(req.query.limit) || 20;
            const summaries = agent.db.getSummaries(limit);
            res.json({ summaries });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/summaries/clear', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            agent.db.clearSummaries();
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Goals ---
    router.get('/goals', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const goals = agent.db.getPendingGoals();
            res.json({ goals });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/goals', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { description, metadata } = req.body;
            agent.db.addGoal(description, metadata);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.put('/goals/:id', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { status, description, clearTaint } = req.body;
            agent.db.updateGoal(req.params.id, { status, description, clearTaint: clearTaint === true });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete('/goals/:id', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            agent.db.deleteGoal(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Aliases ---
    router.get('/aliases', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const aliases = agent.db.listAliases();
            res.json({ aliases });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/aliases', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { alias, entityId } = req.body;
            agent.db.saveDeviceAlias(alias, entityId);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.delete('/aliases/:alias', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            agent.db.deleteAlias(req.params.alias);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Backups ---
    router.get('/backups', async (req, res) => {
        if (!agent.backupManager) return res.status(503).json({ error: 'Backup manager not ready' });
        try {
            const files = await agent.backupManager.getBackups();
            res.json({ files });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/backups', async (req, res) => {
        if (!agent.backupManager) return res.status(503).json({ error: 'Backup manager not ready' });
        try {
            const result = await agent.backupManager.performBackup();
            if (result.error) return res.status(500).json(result);
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Config / Env (Read-Only) ---
    router.get('/config/env', (req, res) => {
        // Allowlist of safe keys to display
        const SAFE_KEYS = [
            'NODE_ENV', 'PORT', 'AGENT_URL', 'INTERFACES_URL', 'SUPERVISOR_URL',
            'RATE_LIMIT_HOURLY', 'RATE_LIMIT_DAILY', 'MAX_TOOL_LOOPS',
            'ROUTER_MODEL', 'WORKER_FLASH', 'WORKER_PRO', 'WORKER_GOOGLE_SEARCH',
            'GEMINI_TTS_MODEL', 'GEMINI_IMAGE_MODEL',
            'GCS_BACKUP_BUCKET', 'GCS_BACKUP_PATH', 'ENABLE_WHATSAPP'
        ];

        const env = {};
        SAFE_KEYS.forEach(key => {
            if (process.env[key]) env[key] = process.env[key];
        });

        // Also check if secrets are set (boolean only)
        env.HAS_GOOGLE_KEY = !!process.env.GOOGLE_API_KEY;
        env.HAS_TELEGRAM_TOKEN = !!process.env.TELEGRAM_TOKEN;
        env.HAS_SLACK_TOKEN = !!process.env.SLACK_TOKEN;
        env.HAS_GITHUB_PAT = !!process.env.GITHUB_PAT;

        res.json({ env });
    });

    router.get('/config', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const searchStrategy = agent.db.getKey('config:search_strategy') || { mode: 'HYBRID' };
            res.json({ searchStrategy });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/config', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { key, value } = req.body;
            // Keys allowed: 'search_strategy'
            if (key !== 'search_strategy') return res.status(400).json({ error: 'Invalid config key' });

            agent.db.setKey(`config:${key}`, value);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Agent settings live in routes/settings.js, mounted at /internal/settings.
    // A second, unmasked copy of GET and POST used to sit here and returned
    // provider keys in clear.

    // --- Browser Secrets ---
    // The Settings UI edits a JSON map. The browser MCP server reads a dotenv
    // rendering of it (--secrets), so a save writes both and restarts that
    // server. The restart waits while a browser_ call is in flight.
    const browserDataDir = () => process.env.DATA_DIR || agent.dataDir || (agent.db && agent.db.dbPath ? path.dirname(agent.db.dbPath) : path.join(process.cwd(), 'data'));

    // Names only. These are site passwords; every DEEDEE_API_TOKEN holder
    // (iOS Shortcuts, the monitor) can reach this route through the api.
    router.get('/browser-secrets', (req, res) => {
        try {
            res.json({ names: browserSecrets.readSecretNames(browserDataDir()) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    /** Restarts the browser MCP server so it reads the new secrets file. */
    const restartBrowser = async () => {
        if (!agent.mcp?.restartServer || !agent.mcp.config?.browser) return { skipped: true };
        try {
            return await agent.mcp.restartServer('browser');
        } catch (e) {
            console.warn('[API] browser server restart after secrets save failed:', e.message);
            return { error: e.message };
        }
    };

    // One secret at a time: set or replace.
    router.put('/browser-secrets/:name', async (req, res) => {
        try {
            const name = req.params.name;
            const value = req.body?.value;
            if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
            let count;
            try {
                count = browserSecrets.upsertSecret(browserDataDir(), name, value);
            } catch (e) {
                return res.status(400).json({ error: e.message });
            }
            res.json({ success: true, count, restart: await restartBrowser() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // One secret at a time: remove.
    router.delete('/browser-secrets/:name', async (req, res) => {
        try {
            const { count, removed } = browserSecrets.removeSecret(browserDataDir(), req.params.name);
            if (!removed) return res.status(404).json({ error: 'No such secret' });
            res.json({ success: true, count, restart: await restartBrowser() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Browser live view ---
    // The interfaces service forwards socket events here; the API proxies
    // status and start for the /browser page. See services/browser-live.js.
    const live = (res) => {
        if (!agent.browserLive) { res.status(503).json({ error: 'Browser live view not ready' }); return null; }
        return agent.browserLive;
    };
    const liveReply = (res, result) => {
        if (result && result.error) return res.status(409).json(result);
        res.json(result);
    };

    router.post('/browser/live/watch', async (req, res) => {
        const bl = live(res); if (!bl) return;
        try { res.json(await bl.watch(req.body?.watcherId)); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/browser/live/input', async (req, res) => {
        const bl = live(res); if (!bl) return;
        const event = req.body?.event;
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
            return res.status(400).json({ error: 'event with a type is required' });
        }
        try { liveReply(res, await bl.input(event)); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/browser/live/navigate', async (req, res) => {
        const bl = live(res); if (!bl) return;
        if (typeof req.body?.url !== 'string') return res.status(400).json({ error: 'url is required' });
        try { liveReply(res, await bl.navigate(req.body.url)); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/browser/live/start', async (req, res) => {
        const bl = live(res); if (!bl) return;
        try { liveReply(res, await bl.start()); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/browser/live/status', (req, res) => {
        const bl = live(res); if (!bl) return;
        try { res.json(bl.status()); } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Logs ---
    router.get('/logs/jobs', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;
            const { search, status } = req.query;
            const result = agent.db.getJobLogs(limit, offset, { search, status });

            // Enrich with cost data, and with where the run's messages are:
            // { chatId, since? } or null (a job that ran no model has none).
            const costs = agent.db.getJobLogCosts(result.logs.map(l => l.id));
            result.logs = result.logs.map(l => ({
                ...l,
                cost: costs[l.id]?.totalCost || 0,
                tokens: costs[l.id]?.totalTokens || 0,
                history: agent.db.getJobRunHistory(l)
            }));

            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/logs/jobs/delete', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { ids } = req.body;
            if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
            agent.db.deleteJobLogs(ids);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/jobs/:name/state', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const state = agent.db.getJobState(req.params.name);
            res.json({ state });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    // --- Sub-Agents ---
    router.get('/subagents', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const parentChatId = req.query.parentChatId || null;
            const page = Math.max(1, parseInt(req.query.page) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
            const { search, status } = req.query;
            const { tasks, total, page: pg, limit: lim } = agent.db.listSubAgents(parentChatId, { page, limit, search, status });

            // Enrich with cost data
            const taskIds = tasks.map(t => t.id);
            const costs = agent.db.getSubAgentCosts(taskIds);
            const enriched = tasks.map(t => ({
                ...t,
                cost: costs[t.id]?.totalCost || 0,
                tokens: costs[t.id]?.totalTokens || 0
            }));

            res.json({ tasks: enriched, total, page: pg, limit: lim, totalPages: Math.ceil(total / lim) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/subagents/:id', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const task = agent.db.getSubAgent(req.params.id);
            if (!task) return res.status(404).json({ error: 'Sub-agent task not found' });
            res.json(task);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/subagents/cleanup', (req, res) => {
        if (!agent.subAgentService) return res.status(503).json({ error: 'Sub-agent service not ready' });
        try {
            const result = agent.subAgentService.cleanup();
            res.json({ success: true, ...result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Cron Helper (Natural Language → Cron Expression) ---
    router.post('/cron-helper', async (req, res) => {
        try {
            const { text } = req.body;
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                return res.status(400).json({ error: 'text is required' });
            }

            // Cap input length to prevent abuse
            const input = text.trim().slice(0, 200);

            const { ConfigService } = require('../services/config-service');
            const config = new ConfigService();
            const modelName = config.getModel('LITE');

            const { GoogleGenAI } = await import('@google/genai');
            const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

            const prompt = `You convert natural language schedule descriptions into standard 5-field cron expressions (minute hour dayOfMonth month dayOfWeek).

Rules:
- Output ONLY valid JSON: {"cron": "<expression>", "description": "<human readable>"}
- Use 24-hour time internally but describe in 12-hour format with AM/PM
- Day of week: 0=Sunday, 1=Monday, ..., 6=Saturday
- If the input is ambiguous, pick the most reasonable interpretation
- If the input cannot be converted to a cron expression, return {"error": "Could not parse schedule"}

Examples:
"every friday at 5pm" → {"cron": "0 17 * * 5", "description": "Every Friday at 5:00 PM"}
"weekdays at 9am" → {"cron": "0 9 * * 1-5", "description": "Weekdays at 9:00 AM"}
"every hour" → {"cron": "0 * * * *", "description": "Every hour, on the hour"}
"first day of every month at midnight" → {"cron": "0 0 1 * *", "description": "1st of every month at 12:00 AM"}

Input: "${input.replace(/"/g, '\\"')}"`;

            const thinking = config.getThinkingConfig('LITE', 'cron_helper', { model: modelName });
            const response = await client.models.generateContent({
                model: modelName,
                contents: prompt,
                config: {
                    responseMimeType: 'application/json',
                    temperature: 0.0,
                    ...(thinking ? { thinkingConfig: thinking } : {})
                }
            });

            config.logUsageFromResponse(agent.db, modelName, response, null, 'cron_helper');

            let responseText = '';
            if (typeof response.text === 'function') {
                responseText = response.text();
            } else if (response.text) {
                responseText = response.text;
            }

            // Extract JSON from response
            const firstBrace = responseText.indexOf('{');
            const lastBrace = responseText.lastIndexOf('}');
            if (firstBrace === -1 || lastBrace === -1) {
                return res.status(422).json({ error: 'Could not parse schedule' });
            }

            const parsed = JSON.parse(responseText.substring(firstBrace, lastBrace + 1));

            if (parsed.error) {
                return res.status(422).json({ error: parsed.error });
            }

            if (!parsed.cron) {
                return res.status(422).json({ error: 'Could not parse schedule' });
            }

            // Basic cron format validation (5 fields)
            const fields = parsed.cron.trim().split(/\s+/);
            if (fields.length !== 5) {
                return res.status(422).json({ error: 'Invalid cron expression generated' });
            }

            res.json({ cron: parsed.cron.trim(), description: parsed.description || '' });
        } catch (e) {
            console.error('[CronHelper] Error:', e.message);
            res.status(500).json({ error: 'Failed to parse schedule' });
        }
    });

    return router;
}

module.exports = { createInternalRouter };
