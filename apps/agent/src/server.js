require('dotenv').config();
const express = require('express');
const { Agent } = require('./agent');
const { HttpInterface } = require('./http-interface');

const app = express();
const port = process.env.PORT || 3000;
const interfacesUrl = process.env.INTERFACES_URL || 'http://localhost:5000';
const googleApiKey = process.env.GOOGLE_API_KEY;

// Increase body limit to support large audio/image payloads
app.use(express.json({ limit: '50mb' }));

// Global Error Handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('[System] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[System] Uncaught Exception:', error);
  // Ideally, we should exit here, but in "YOLO" mode we try to stay up.
  // process.exit(1);
});

// 0. Environment & Secrets Setup
const fs = require('fs');
const path = require('path');

// Handle Base64 encoded Google Credentials (common in Balena/Container envs)
if (process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_APPLICATION_CREDENTIALS.startsWith('/')) {
  try {
    console.log('[Setup] Detecting Base64/Content in GOOGLE_APPLICATION_CREDENTIALS...');
    const credsContent = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    let jsonContent;

    // Check if it's Base64
    if (/^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/.test(credsContent) && !credsContent.trim().startsWith('{')) {
      const buff = Buffer.from(credsContent, 'base64');
      jsonContent = buff.toString('utf-8');
    } else {
      // Assume it's raw JSON string
      jsonContent = credsContent;
    }

    // Validate it looks like JSON
    JSON.parse(jsonContent);

    // Write to file
    const credsPath = path.join('/tmp', 'google-service-account.json');

    fs.writeFileSync(credsPath, jsonContent);
    console.log(`[Setup] Wrote Google Credentials to ${credsPath}`);

    // Point SDK to the file
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credsPath;
  } catch (e) {
    console.error('[Setup] Failed to process GOOGLE_APPLICATION_CREDENTIALS content:', e.message);
    // Proceeding might fail if the SDK expects a path
  }
}

// 1. Setup Interface
const httpInterface = new HttpInterface(interfacesUrl);

// 2. Setup Agent
// Note: We might want to persist the agent instance if it has state (it will have SQLite later)
let agent;
if (googleApiKey) {
  agent = new Agent({
    googleApiKey,
    interface: httpInterface
  });
  agent.start().catch(console.error);
} else {
  console.warn('[Agent] GOOGLE_API_KEY missing. Agent not started.');
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', initialized: !!agent });
});

app.post('/webhook', (req, res) => {
  const message = req.body;

  if (!message || (!message.content && !message.parts)) {
    return res.status(400).json({ error: 'Invalid message format' });
  }

  // Inject into Agent
  if (agent) {
    // Normalize message fields
    message.role = message.role || 'user';
    message.source = message.source || 'http';
    message.timestamp = message.timestamp || new Date().toISOString();

    httpInterface.receive(message);
    res.json({ received: true });
  } else {
    res.status(503).json({ error: 'Agent not initialized' });
  }
});

app.post('/chat', async (req, res) => {
  const message = req.body;

  if (!message || (!message.content && !message.parts)) {
    return res.status(400).json({ error: 'Invalid message format' });
  }

  if (agent) {
    // Normalize message fields
    message.role = message.role || 'user';
    message.source = message.source || 'http';
    message.timestamp = message.timestamp || new Date().toISOString();

    const replies = [];
    try {
      const executionSummary = await agent.processMessage(message, async (reply) => {
        replies.push(reply);
      }, async (status) => {
        // Report progress to Interface Service
        if (message.metadata?.chatId) {
          httpInterface.sendProgress(message.metadata.chatId, status);
        }
      });

      // Use the captured 'replies' (from callbacks) as the source of truth for what to send back.
      // This ensures we respect:
      // 1. Tool-generated outputs (Audio/Image) which are sent via callback but not always in summary.
      // 2. Suppression logic (Text suppressed via callback is not in 'replies').
      let finalReplies = replies.length > 0 ? replies : (executionSummary?.replies || []);

      // Only filter strictly for the iOS Shortcut (source=iphone OR source=ios_shortcut)
      // This keeps "Thinking..." messages for other clients like Web Dashboards.
      if (['iphone', 'ios_shortcut'].includes(message.source)) {
        finalReplies = finalReplies.filter(r => {
          const c = r.content || '';
          return !c.startsWith('Thinking...') &&
            !c.startsWith('Still working...') &&
            !c.startsWith('Action **');
        });
      }

      res.json({
        replies: finalReplies,
        toolOutputs: executionSummary ? executionSummary.toolOutputs : []
      });
    } catch (error) {
      console.error('[Agent] Chat processing error:', error);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(503).json({ error: 'Agent not initialized' });
  }
});

// --- INTERNAL MANAGEMENT ENDPOINTS ---

app.get('/internal/journal', (req, res) => {
  if (!agent || !agent.journal) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const files = fs.readdirSync(agent.journal.journalDir)
      .filter(f => f.endsWith('.md'))
      .sort().reverse();
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/internal/journal/:date', (req, res) => {
  if (!agent || !agent.journal) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { date } = req.params; // Expect filename like "2024-01-01.md" or just date?
    // Let's assume input is YYYY-MM-DD
    const filename = date.endsWith('.md') ? date : `${date}.md`;

    // Security: Prevent Directory Traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = path.join(agent.journal.journalDir, filename);

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Journal not found' });

    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ date, content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/internal/facts', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    // We need to access KV store directly or add getter.
    // agent.db.getKey is for single key. checking db.js... db.db is exposed? Yes.
    // agent.db.db is the better-sqlite3 instance.
    const stmt = agent.db.db.prepare('SELECT key, value, updated_at FROM kv_store ORDER BY updated_at DESC');
    const rows = stmt.all();
    // Parse values if they are JSON
    const facts = rows.map(r => {
      try { return { ...r, value: JSON.parse(r.value) }; }
      catch (e) { return r; }
    });
    res.json({ facts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/internal/tasks', (req, res) => {
  if (!agent || !agent.scheduler) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const jobs = Object.values(agent.scheduler.jobs).map(j => ({
      name: j.metadata?.name || 'unknown',
      cron: j.metadata?.cronExpression || 'unknown',
      task: j.metadata?.payload?.task || '',
      isSystem: j.metadata?.payload?.isSystem || false,
      task: j.metadata?.payload?.task || '',
      isSystem: j.metadata?.payload?.isSystem || false,
      isOneOff: j.metadata?.payload?.isOneOff || false,
      expiresAt: j.metadata?.expiresAt || null,
      nextInvocation: j.nextInvocation()
    }));
    res.json({ jobs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/internal/tasks/:id/cancel', (req, res) => {
  if (!agent || !agent.scheduler) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { id } = req.params;

    // Security: Prevent cancelling system jobs
    const job = agent.scheduler.jobs[id];
    if (job && job.metadata?.payload?.isSystem) {
      return res.status(403).json({ error: 'Cannot cancel system jobs' });
    }

    agent.scheduler.cancelJob(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/internal/tasks/:id/run', async (req, res) => {
  if (!agent || !agent.scheduler) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { id } = req.params;
    await agent.scheduler.runJob(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// --- Stats ---
app.get('/internal/stats', (req, res) => {
  if (!agent || !agent.db || !agent.journal) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { start, end } = req.query;
    const dbStats = agent.db.getStats(start, end);
    const journalStats = agent.journal.getStats(start, end);
    const latencyStats = agent.db.getLatencyStats(start, end);
    const contextStats = agent.smartContext.getStats(); // Context stats are global/current

    res.json({
      ...dbStats,
      journal: journalStats,
      latency: latencyStats,
      smartContext: contextStats
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/cleanup', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    agent.db.clearMetrics();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/stats/latency', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { limit, start, end } = req.query;
    const trend = agent.db.getLatencyTrend(limit || 100, start, end);
    res.json(trend);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/stats/usage', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { start, end } = req.query;
    const usage = agent.db.getTokenUsageStats(start, end);
    res.json(usage);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Chat Sessions (Internal) ---
app.get('/internal/sessions', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const sessions = agent.db.getSessions({ limit, offset });
    res.json({ sessions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/sessions', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { id, title, reuseEmpty } = req.body;

    if (reuseEmpty) {
      const existing = agent.db.getLatestEmptySession();
      if (existing) {
        console.log(`[Agent] Reusing empty session ${existing.id}`);
        return res.json(existing);
      }
    }

    const session = agent.db.createSession({ id, title });
    res.json(session);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/sessions/:id', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const session = agent.db.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Include recent history
    const history = agent.db.getHistory({ chatId: req.params.id, limit: 100 });
    session.messages = history;

    res.json(session);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/internal/sessions/:id', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { title, isArchived } = req.body;
    agent.db.updateSession(req.params.id, { title, isArchived });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/internal/sessions/:id', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    agent.db.deleteSession(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- History ---
app.get('/internal/history', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const limit = parseInt(req.query.limit) || 100;
    const since = req.query.since;
    const until = req.query.until;
    const chatId = req.query.chatId;
    const order = req.query.order || 'DESC';

    // Support legacy limit-only call or new options
    const history = agent.db.getHistory({ limit, since, until, chatId, order });
    res.json({ history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/internal/history/:id', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    agent.db.deleteMessage(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Summaries ---
app.get('/internal/summaries', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const limit = parseInt(req.query.limit) || 20;
    const summaries = agent.db.getSummaries(limit);
    res.json({ summaries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/summaries/clear', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    agent.db.clearSummaries();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Journal ---
app.put('/internal/journal/:date', (req, res) => {
  if (!agent || !agent.journal) return res.status(503).json({ error: 'Agent not ready' });
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

    // Double check resolved path is inside journalDir
    const resolvedPath = path.resolve(filePath);
    const resolvedJournalDir = path.resolve(agent.journal.journalDir);
    if (!resolvedPath.startsWith(resolvedJournalDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/internal/journal/:date', (req, res) => {
  if (!agent || !agent.journal) return res.status(503).json({ error: 'Agent not ready' });
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
app.post('/internal/facts', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { key, value } = req.body;
    agent.db.setKey(key, value);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/internal/facts/:key', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    agent.db.deleteFact(req.params.key);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Goals ---
app.get('/internal/goals', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const goals = agent.db.getPendingGoals();
    res.json({ goals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/goals', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { description, metadata } = req.body;
    agent.db.addGoal(description, metadata);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/internal/goals/:id', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { status, description } = req.body;
    agent.db.updateGoal(req.params.id, { status, description });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/internal/goals/:id', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    agent.db.deleteGoal(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Aliases ---
app.get('/internal/aliases', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const aliases = agent.db.listAliases();
    res.json({ aliases });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/aliases', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { alias, entityId } = req.body;
    agent.db.saveDeviceAlias(alias, entityId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/internal/stats/cost-trend', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { start, end } = req.query;
    const limit = parseInt(req.query.limit || '100', 10);
    const trend = agent.db.getTokenUsageTrend(limit, start, end);
    res.json(trend);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/internal/aliases/:alias', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    agent.db.deleteAlias(req.params.alias);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Configuration ---
app.get('/internal/config', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const searchStrategy = agent.db.getKey('config:search_strategy') || { mode: 'HYBRID' };
    res.json({ searchStrategy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/config', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { key, value } = req.body;
    // Keys allowed: 'search_strategy'
    if (key !== 'search_strategy') return res.status(400).json({ error: 'Invalid config key' });

    agent.db.setKey(`config:${key}`, value);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Logs ---
app.get('/internal/logs/jobs', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const logs = agent.db.getJobLogs(limit, offset);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/logs/jobs/delete', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
    agent.db.deleteJobLogs(ids);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Scheduler (Create) ---
app.post('/internal/scheduler', (req, res) => {
  if (!agent || !agent.scheduler) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { name, cron, task, expiresAt, isOneOff } = req.body;

    // Security: Prevent overwriting system jobs
    const existingJob = agent.scheduler.jobs[name];
    if (existingJob && existingJob.metadata?.payload?.isSystem) {
      return res.status(403).json({ error: 'Cannot modify system jobs' });
    }

    const callback = async () => {
      console.log(`[Scheduler] Executing task: ${task}`);

      let executionResult = null;
      await agent.processMessage({
        role: 'user',
        content: `Scheduled Task: ${task}`,
        source: 'scheduler',
        metadata: { chatId: `scheduled_${name}` }
      }, async (reply) => {
        if (agent.interface) {
          await agent.interface.send(reply);
        }
        // Capture reply
        if (!executionResult) executionResult = reply;
        else if (reply.text) executionResult.text = (executionResult.text || '') + '\n' + reply.text;
      });
      return executionResult;
    };

    agent.scheduler.scheduleJob(name, cron, callback, {
      persist: true,
      taskType: 'agent_instruction',
      payload: { task },
      expiresAt: expiresAt || null,
      oneOff: !!isOneOff
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Backups ---
app.get('/internal/backups', async (req, res) => {
  if (!agent || !agent.backupManager) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const files = await agent.backupManager.getBackups();
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/backups', async (req, res) => {
  if (!agent || !agent.backupManager) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const result = await agent.backupManager.performBackup();
    if (result.error) return res.status(500).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Config / Env (Read-Only) ---
app.get('/internal/config/env', (req, res) => {
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

app.get('/internal/jobs/:name/state', (req, res) => {
  if (!agent || !agent.db) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const state = agent.db.getJobState(req.params.name);
    res.json({ state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- GEMINI LIVE (Real-time) ---
const { GoogleAuth } = require('google-auth-library');

app.post('/live/token', async (req, res) => {
  try {
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/generative-language.retriever.readonly'
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    res.json({ token: token.token });
  } catch (error) {
    console.error('[Agent] Failed to generate ephemeral token:', error);
    res.status(500).json({ error: 'Token generation failed' });
  }
});

// --- Live Tool Sync ---
app.get('/internal/tools', async (req, res) => {
  if (!agent || !agent.mcp) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const tools = await agent.mcp.getTools();
    // Wrap to JSON structure
    res.json({ tools });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/tools/execute', async (req, res) => {
  if (!agent || !agent.toolExecutor) return res.status(503).json({ error: 'Agent not ready' });
  try {
    const { name, args } = req.body;
    console.log(`[Agent] Executing tool request from Live Client: ${name}`, args);

    // Context simulation for the tool executor
    const context = {
      message: { source: 'live', metadata: { chatId: 'live-session' } },
      sendCallback: async (msg) => console.log('[Agent] Live Tool Output:', msg), // No-op for direct response
      processMessage: agent.processMessage
    };

    const result = await agent.toolExecutor.execute(name, args, context);
    res.json({ result });
  } catch (error) {
    console.error('[Agent] Live Tool Execution Failed:', error);
    res.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Agent listening at http://localhost:${port}`);
  });
}

module.exports = { app, agent };
