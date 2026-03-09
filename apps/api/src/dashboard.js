const express = require('express');
const axios = require('axios');
const router = express.Router();

const agentUrl = process.env.AGENT_URL || 'http://localhost:3000';

// Helper for proxying methods
const proxyRequest = async (req, res, method, path, data) => {
    try {
        const response = await axios({ method, url: `${agentUrl}${path}`, data, params: req.query });
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Proxy Error (${method} ${path}):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ error: 'Agent unavailable' });
        }
    }
};

// Journal
router.get('/journal', (req, res) => proxyRequest(req, res, 'GET', '/internal/journal'));
router.get('/journal/:date', (req, res) => proxyRequest(req, res, 'GET', `/internal/journal/${encodeURIComponent(req.params.date)}`));

router.get('/stats', (req, res) => proxyRequest(req, res, 'GET', '/internal/stats'));
router.get('/stats/latency', (req, res) => proxyRequest(req, res, 'GET', '/internal/stats/latency'));
router.get('/stats/usage', (req, res) => proxyRequest(req, res, 'GET', '/internal/stats/usage'));
router.get('/stats/cost-trend', (req, res) => proxyRequest(req, res, 'GET', '/internal/stats/cost-trend'));
router.get('/stats/daily-cost', (req, res) => proxyRequest(req, res, 'GET', '/internal/stats/daily-cost'));
router.post('/cleanup', (req, res) => proxyRequest(req, res, 'POST', '/internal/cleanup'));
router.put('/journal/:date', (req, res) => proxyRequest(req, res, 'PUT', `/internal/journal/${encodeURIComponent(req.params.date)}`, req.body));
router.delete('/journal/:date', (req, res) => proxyRequest(req, res, 'DELETE', `/internal/journal/${encodeURIComponent(req.params.date)}`));

// Logs
router.get('/logs/jobs', (req, res) => proxyRequest(req, res, 'GET', '/internal/logs/jobs'));
router.post('/logs/jobs/delete', (req, res) => proxyRequest(req, res, 'POST', '/internal/logs/jobs/delete', req.body));
router.get('/jobs/:name/state', (req, res) => proxyRequest(req, res, 'GET', `/internal/jobs/${encodeURIComponent(req.params.name)}/state`));

// Facts
router.get('/facts', (req, res) => proxyRequest(req, res, 'GET', '/internal/facts'));
router.post('/facts', (req, res) => proxyRequest(req, res, 'POST', '/internal/facts', req.body));
router.delete('/facts/:key', (req, res) => proxyRequest(req, res, 'DELETE', `/internal/facts/${encodeURIComponent(req.params.key)}`));

// Tasks
router.get('/tasks', (req, res) => proxyRequest(req, res, 'GET', '/internal/tasks'));
router.post('/tasks', (req, res) => proxyRequest(req, res, 'POST', '/internal/scheduler', req.body));
router.post('/cron-helper', (req, res) => proxyRequest(req, res, 'POST', '/internal/cron-helper', req.body));
router.post('/tasks/:id/cancel', (req, res) => proxyRequest(req, res, 'POST', `/internal/tasks/${encodeURIComponent(req.params.id)}/cancel`));
router.post('/tasks/:id/toggle', (req, res) => proxyRequest(req, res, 'POST', `/internal/tasks/${encodeURIComponent(req.params.id)}/toggle`, req.body));
router.post('/tasks/:id/run', (req, res) => proxyRequest(req, res, 'POST', `/internal/tasks/${encodeURIComponent(req.params.id)}/run`));

// History
router.get('/history', (req, res) => proxyRequest(req, res, 'GET', '/internal/history'));
router.get('/summaries', (req, res) => proxyRequest(req, res, 'GET', '/internal/summaries'));
router.delete('/history/:id', (req, res) => proxyRequest(req, res, 'DELETE', `/internal/history/${encodeURIComponent(req.params.id)}`));

// Goals
router.get('/goals', (req, res) => proxyRequest(req, res, 'GET', '/internal/goals'));
router.post('/goals', (req, res) => proxyRequest(req, res, 'POST', '/internal/goals', req.body));
router.put('/goals/:id', (req, res) => proxyRequest(req, res, 'PUT', `/internal/goals/${encodeURIComponent(req.params.id)}`, req.body));
router.delete('/goals/:id', (req, res) => proxyRequest(req, res, 'DELETE', `/internal/goals/${encodeURIComponent(req.params.id)}`));

// Aliases
router.get('/aliases', (req, res) => proxyRequest(req, res, 'GET', '/internal/aliases'));
router.post('/aliases', (req, res) => proxyRequest(req, res, 'POST', '/internal/aliases', req.body));
router.delete('/aliases/:alias', (req, res) => proxyRequest(req, res, 'DELETE', `/internal/aliases/${encodeURIComponent(req.params.alias)}`));

// Sessions
router.get('/sessions', (req, res) => proxyRequest(req, res, 'GET', '/internal/sessions'));
router.post('/sessions', (req, res) => proxyRequest(req, res, 'POST', '/internal/sessions', req.body));
router.get('/sessions/:id', (req, res) => proxyRequest(req, res, 'GET', `/internal/sessions/${encodeURIComponent(req.params.id)}`));
router.put('/sessions/:id', (req, res) => proxyRequest(req, res, 'PUT', `/internal/sessions/${encodeURIComponent(req.params.id)}`, req.body));
router.delete('/sessions/:id', (req, res) => proxyRequest(req, res, 'DELETE', `/internal/sessions/${encodeURIComponent(req.params.id)}`));

// Config
router.get('/config', (req, res) => proxyRequest(req, res, 'GET', '/internal/config'));
router.post('/config', (req, res) => proxyRequest(req, res, 'POST', '/internal/config', req.body));
router.get('/config/env', (req, res) => proxyRequest(req, res, 'GET', '/internal/config/env'));

// MCP Status
router.get('/mcp/status', (req, res) => proxyRequest(req, res, 'GET', '/internal/mcp/status'));

// Backups
router.get('/backups', (req, res) => proxyRequest(req, res, 'GET', '/internal/backups'));
router.post('/backups', (req, res) => proxyRequest(req, res, 'POST', '/internal/backups', req.body));

// Settings (Agent)
router.get('/settings', (req, res) => proxyRequest(req, res, 'GET', '/internal/settings'));
router.post('/settings', (req, res) => proxyRequest(req, res, 'POST', '/internal/settings', req.body));
router.post('/settings/tts/preview', (req, res) => proxyRequest(req, res, 'POST', '/internal/settings/tts/preview', req.body));

// Sub-Agents
router.get('/subagents', (req, res) => proxyRequest(req, res, 'GET', '/internal/subagents'));
router.get('/subagents/:id', (req, res) => proxyRequest(req, res, 'GET', `/internal/subagents/${encodeURIComponent(req.params.id)}`));
router.post('/subagents/cleanup', (req, res) => proxyRequest(req, res, 'POST', '/internal/subagents/cleanup'));

module.exports = router;
