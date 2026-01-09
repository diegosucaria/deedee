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

module.exports = router;
