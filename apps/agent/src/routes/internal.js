const express = require('express');
const fs = require('fs');
const path = require('path');

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
                    isOneOff: j.metadata?.payload?.isOneOff || false,
                    enabled: j.metadata?.enabled !== false,
                    expiresAt: j.metadata?.expiresAt || null,
                    nextInvocation: j.nextInvocation(),
                    model: j.metadata?.payload?.model || 'auto',
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

            const payload = {
                task,
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
                        chatId: `scheduled_${name}`,
                        ...(payload.model ? { forceModel: payload.model } : {}),
                        ...(payload.allowedTools ? { allowedTools: payload.allowedTools } : {})
                    }
                }, async (reply) => {
                    if (agent.interface) {
                        await agent.interface.send(reply);
                    }
                    if (!executionResult) executionResult = reply;
                    else if (reply.text) executionResult.text = (executionResult.text || '') + '\n' + reply.text;
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
    router.get('/stats', (req, res) => {
        if (!agent.db || !agent.journal) return res.status(503).json({ error: 'Stats dependencies not ready' });
        try {
            const { start, end } = req.query;
            const dbStats = agent.db.getStats(start, end);
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
            const { limit, start, end } = req.query;
            const trend = agent.db.getLatencyTrend(limit || 100, start, end);
            res.json(trend);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/usage', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { start, end } = req.query;
            const usage = agent.db.getTokenUsageStats(start, end);
            res.json(usage);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/cost-trend', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { start, end } = req.query;
            const limit = parseInt(req.query.limit || '100', 10);
            const trend = agent.db.getTokenUsageTrend(limit, start, end);
            res.json(trend);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/stats/daily-cost', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const limit = parseInt(req.query.limit || '7', 10);
            const trend = agent.db.getDailyCostTrend(limit);
            res.json(trend);
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
            const history = agent.db.getHistory({
                limit,
                since: req.query.since,
                until: req.query.until,
                chatId: req.query.chatId,
                order: req.query.order || 'DESC'
            });
            res.json({ history });
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
            const { status, description } = req.body;
            agent.db.updateGoal(req.params.id, { status, description });
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

    // --- Agent Settings (Private/Secrets) ---
    router.get('/settings', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const settings = agent.db.getAllAgentSettings();
            // Mask sensitive keys if needed? 
            // For now, this is internal Admin API, so returning as is is acceptable
            // provided the UI handles masking (which it does with password fields)
            res.json(settings);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/settings', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const { key, value, category } = req.body;
            if (!key || value === undefined) return res.status(400).json({ error: 'Key and Value required' });

            agent.db.setAgentSetting(key, value, category);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Browser Secrets ---
    router.get('/browser-secrets', (req, res) => {
        try {
            // Determine Data Dir similar to AgentDB logic or standard convention
            const dataDir = process.env.DATA_DIR || (agent.db && agent.db.dbPath ? path.dirname(agent.db.dbPath) : path.join(process.cwd(), 'data'));
            const secretsFile = path.join(dataDir, 'browser_profile', 'browser-secrets.json');

            if (!fs.existsSync(secretsFile)) {
                return res.json({});
            }

            const content = fs.readFileSync(secretsFile, 'utf-8');
            try {
                const json = JSON.parse(content);
                res.json(json);
            } catch (e) {
                // If invalid JSON, return empty or error? Let's return raw as text if needed, but UI expects JSON.
                // Or empty object to be safe.
                console.error('[API] Failed to parse browser-secrets.json:', e);
                res.json({});
            }
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    router.post('/browser-secrets', (req, res) => {
        try {
            const secrets = req.body; // Expects JSON object
            if (typeof secrets !== 'object') return res.status(400).json({ error: 'Invalid format. Expected JSON object.' });

            const dataDir = process.env.DATA_DIR || (agent.db && agent.db.dbPath ? path.dirname(agent.db.dbPath) : path.join(process.cwd(), 'data'));
            const userProfileDir = path.join(dataDir, 'browser_profile');
            const secretsFile = path.join(userProfileDir, 'browser-secrets.json');

            // Ensure dir exists
            if (!fs.existsSync(userProfileDir)) {
                fs.mkdirSync(userProfileDir, { recursive: true });
            }

            fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), 'utf-8');
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // --- Logs ---
    router.get('/logs/jobs', (req, res) => {
        if (!agent.db) return res.status(503).json({ error: 'DB not ready' });
        try {
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;
            const logs = agent.db.getJobLogs(limit, offset);
            res.json(logs);
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
            const tasks = agent.db.listSubAgents(parentChatId);
            res.json({ tasks });
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

    return router;
}

module.exports = { createInternalRouter };
