const express = require('express');
const axios = require('axios');

const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// Browser secrets are site passwords. Reads return names only; writes name one
// secret at a time. axios carries the internal bearer (see server.js).
const forwardToAgent = async (req, res, method, path, data) => {
    try {
        const response = await axios({ method, url: `${AGENT_URL}/internal/browser-secrets${path}`, data });
        res.json(response.data);
    } catch (error) {
        if (error.response) return res.status(error.response.status).json(error.response.data);
        console.error('[API] Secrets Proxy Error:', error.message);
        res.status(502).json({ error: `Failed to connect to Agent: ${error.message}` });
    }
};

router.get('/', (req, res) => forwardToAgent(req, res, 'GET', '', null));
router.put('/:name', (req, res) => forwardToAgent(req, res, 'PUT', `/${encodeURIComponent(req.params.name)}`, req.body));
router.delete('/:name', (req, res) => forwardToAgent(req, res, 'DELETE', `/${encodeURIComponent(req.params.name)}`, null));

module.exports = router;
