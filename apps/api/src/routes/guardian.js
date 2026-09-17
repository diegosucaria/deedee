const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// /v1/guardian -> agent /internal/guardian (approval guardian history, stats,
// policy, dry run, feedback). Bearer auth is applied by the /v1 mount.
const proxyToAgent = async (req, res, method, path, data) => {
    try {
        const response = await axios({ method, url: `${AGENT_URL}/internal/guardian${path}`, data, params: req.query });
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Guardian Proxy Error (${method} ${path}):`, error.message);
        if (error.response) res.status(error.response.status).json(error.response.data);
        else res.status(502).json({ error: 'Agent Service unavailable' });
    }
};

router.get('/history', (req, res) => proxyToAgent(req, res, 'GET', '/history', null));
router.get('/history/:id', (req, res) => proxyToAgent(req, res, 'GET', `/history/${encodeURIComponent(req.params.id)}`, null));
router.get('/stats', (req, res) => proxyToAgent(req, res, 'GET', '/stats', null));
router.get('/policy', (req, res) => proxyToAgent(req, res, 'GET', '/policy', null));
router.put('/policy', (req, res) => proxyToAgent(req, res, 'PUT', '/policy', req.body));
router.post('/dry-run', (req, res) => proxyToAgent(req, res, 'POST', '/dry-run', req.body));
router.post('/feedback/:id', (req, res) => proxyToAgent(req, res, 'POST', `/feedback/${encodeURIComponent(req.params.id)}`, req.body));

module.exports = router;
