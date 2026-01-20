const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

const proxyToAgent = async (req, res, method, path, data) => {
    try {
        const url = `${AGENT_URL}/internal/autopilot${path}`;
        const config = {
            method,
            url,
            data,
            params: req.query
        };

        const response = await axios(config);
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Autopilot Proxy Error (${method} ${path}):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(502).json({ error: 'Agent Service unavailable' });
        }
    }
};

// Drafts
router.get('/drafts', (req, res) => proxyToAgent(req, res, 'GET', '/drafts', null));
router.post('/drafts/:id/approve', (req, res) => proxyToAgent(req, res, 'POST', `/drafts/${req.params.id}/approve`, null));
router.post('/drafts/:id/reject', (req, res) => proxyToAgent(req, res, 'POST', `/drafts/${req.params.id}/reject`, null));
router.put('/drafts/:id', (req, res) => proxyToAgent(req, res, 'PUT', `/drafts/${req.params.id}`, req.body));

// Settings
router.get('/settings', (req, res) => proxyToAgent(req, res, 'GET', '/settings', null));
router.post('/settings/:id', (req, res) => proxyToAgent(req, res, 'POST', `/settings/${req.params.id}`, req.body));

module.exports = router;
