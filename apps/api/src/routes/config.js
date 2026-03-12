const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

const proxyToAgent = async (req, res, method, endpoint, data) => {
    try {
        const url = `${AGENT_URL}${endpoint}`;
        const response = await axios({ method, url, data, params: req.query });
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Config Proxy Error (${method} ${endpoint}):`, error.message);
        if (error.response) res.status(error.response.status).json(error.response.data);
        else res.status(502).json({ error: 'Agent Service unavailable' });
    }
};

// Route root /config requests to /internal/settings (Unified Settings Table)
router.get('/', (req, res) => proxyToAgent(req, res, 'GET', '/internal/settings', null));
router.post('/', (req, res) => proxyToAgent(req, res, 'POST', '/internal/settings', req.body));

// Route /config/env to /internal/config/env (Legacy Internal Router)
router.get('/env', (req, res) => proxyToAgent(req, res, 'GET', '/internal/config/env', null));

// Route /watchers to internal Agent endpoints
router.get('/watchers', (req, res) => proxyToAgent(req, res, 'GET', '/internal/watchers', null));
router.post('/watchers', (req, res) => proxyToAgent(req, res, 'POST', '/internal/watchers', req.body));

router.put('/watchers/:id', (req, res) => proxyToAgent(req, res, 'PUT', `/internal/watchers/${req.params.id}`, req.body));

router.delete('/watchers/:id', async (req, res) => {
    try {
        await axios.delete(`${AGENT_URL}/internal/watchers/${req.params.id}`);
        res.json({ success: true });
    } catch (e) {
        console.error('[API] Watcher DELETE Error:', e.message);
        if (e.response) res.status(e.response.status).json(e.response.data);
        else res.status(502).json({ error: 'Agent unavailable' });
    }
});

module.exports = router;
