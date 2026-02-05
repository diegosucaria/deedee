const express = require('express');
const router = express.Router();
const axios = require('axios');

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

const proxyToAgent = async (req, res, method, path, data) => {
    try {
        const url = `${AGENT_URL}/internal/skills${path}`;
        const config = {
            method,
            url,
            data,
            params: req.query
        };

        const response = await axios(config);
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Skills Proxy Error (${method} ${path}):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(502).json({ error: 'Agent Service unavailable' });
        }
    }
};

// GET /v1/skills - List all skills
router.get('/', (req, res) => proxyToAgent(req, res, 'GET', '/', null));

// GET /v1/skills/:name - Get details
router.get('/:name', (req, res) => proxyToAgent(req, res, 'GET', `/${req.params.name}`, null));

// POST /v1/skills/:name/enable
router.post('/:name/enable', (req, res) => proxyToAgent(req, res, 'POST', `/${req.params.name}/toggle`, { enabled: true }));

// POST /v1/skills/:name/disable
router.post('/:name/disable', (req, res) => proxyToAgent(req, res, 'POST', `/${req.params.name}/toggle`, { enabled: false }));

// POST /v1/skills/:name/secrets
router.post('/:name/secrets', (req, res) => proxyToAgent(req, res, 'POST', `/${req.params.name}/secrets`, req.body));

// TODO: Implement Create/Delete proxying if needed (requires Agent endpoints)
// For now, focusing on Visibility/Toggling which solves the immediate "Skills not listed" issue.

module.exports = router;
