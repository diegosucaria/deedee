const express = require('express');
const axios = require('axios');
const router = express.Router();

const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';
const agentUrl = process.env.AGENT_URL || 'http://agent:3000';

const proxyToInterfaces = async (req, res, method, path, data) => {
    try {
        const url = `${interfacesUrl}${path}`;
        const headers = {
            'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}`,
            'Content-Type': 'application/json'
        };
        const response = await axios({ method, url, data, params: req.query, headers });
        res.json(response.data);
    } catch (error) {
        console.error(`[API] GSuite Proxy Error (${method} ${path}):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(502).json({ error: 'Interfaces Service unavailable' });
        }
    }
};

const proxyToAgent = async (req, res, method, path, data) => {
    try {
        const url = `${agentUrl}/internal/settings${path}`;
        const response = await axios({ method, url, data, params: req.query });
        res.json(response.data);
    } catch (error) {
        console.error(`[API] GSuite Agent Proxy Error (${method} ${path}):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(502).json({ error: 'Agent Service unavailable' });
        }
    }
};

// Account management (→ interfaces service)
router.get('/accounts', (req, res) => proxyToInterfaces(req, res, 'GET', '/gsuite/accounts'));
router.post('/auth-url', (req, res) => proxyToInterfaces(req, res, 'POST', '/gsuite/auth-url', req.body));
router.post('/auth', (req, res) => proxyToInterfaces(req, res, 'POST', '/gsuite/auth', req.body));
router.post('/disconnect', (req, res) => proxyToInterfaces(req, res, 'POST', '/gsuite/disconnect', req.body));
router.put('/accounts/:email/label', (req, res) => proxyToInterfaces(req, res, 'PUT', `/gsuite/accounts/${encodeURIComponent(req.params.email)}/label`, req.body));

// Calendar filter (→ agent service, where MCP clients live)
router.get('/calendars/:label', (req, res) => proxyToAgent(req, res, 'GET', `/gws/calendars/${encodeURIComponent(req.params.label)}`));
router.get('/calendar-filter/:label', (req, res) => proxyToAgent(req, res, 'GET', `/gws/calendar-filter/${encodeURIComponent(req.params.label)}`));
router.post('/calendar-filter/:label', (req, res) => proxyToAgent(req, res, 'POST', `/gws/calendar-filter/${encodeURIComponent(req.params.label)}`, req.body));

module.exports = router;
