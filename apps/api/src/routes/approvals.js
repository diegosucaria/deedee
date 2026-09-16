const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// /v1/approvals -> agent /internal/approvals (pending confirmations that
// wait for the owner). Bearer auth is applied by the /v1 mount.
const proxyToAgent = async (req, res, method, path, data) => {
    try {
        const response = await axios({ method, url: `${AGENT_URL}/internal/approvals${path}`, data, params: req.query });
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Approvals Proxy Error (${method} ${path}):`, error.message);
        if (error.response) res.status(error.response.status).json(error.response.data);
        else res.status(502).json({ error: 'Agent Service unavailable' });
    }
};

router.get('/', (req, res) => proxyToAgent(req, res, 'GET', '', null));
router.post('/:id/approve', (req, res) => proxyToAgent(req, res, 'POST', `/${encodeURIComponent(req.params.id)}/approve`, req.body));
router.post('/:id/deny', (req, res) => proxyToAgent(req, res, 'POST', `/${encodeURIComponent(req.params.id)}/deny`, req.body));

module.exports = router;
