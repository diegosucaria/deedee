const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

const proxyToAgent = async (req, res, method, path, data) => {
    try {
        const url = `${AGENT_URL}/internal/settings${path}`;
        const config = { method, url, data, params: req.query, responseType: path.includes('tts') ? 'json' : 'json' };
        const response = await axios(config);
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Settings Proxy Error (${method} ${path}):`, error.message);
        if (error.response) res.status(error.response.status).json(error.response.data);
        else res.status(502).json({ error: 'Agent Service unavailable' });
    }
};

router.get('/', (req, res) => proxyToAgent(req, res, 'GET', '', null));
router.post('/', (req, res) => proxyToAgent(req, res, 'POST', '', req.body));
router.post('/tts/preview', (req, res) => proxyToAgent(req, res, 'POST', '/tts/preview', req.body));

module.exports = router;
