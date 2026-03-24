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
router.post('/gws/upload', (req, res) => proxyToAgent(req, res, 'POST', '/gws/upload', req.body));

// GWS OAuth routes
router.post('/gws/oauth/client', (req, res) => proxyToAgent(req, res, 'POST', '/gws/oauth/client', req.body));
router.get('/gws/oauth/client', (req, res) => proxyToAgent(req, res, 'GET', '/gws/oauth/client', null));
router.get('/gws/oauth/url', (req, res) => proxyToAgent(req, res, 'GET', '/gws/oauth/url', null));
router.post('/gws/oauth/exchange', (req, res) => proxyToAgent(req, res, 'POST', '/gws/oauth/exchange', req.body));
router.get('/gws/validate/:label', (req, res) => proxyToAgent(req, res, 'GET', `/gws/validate/${encodeURIComponent(req.params.label)}`, null));

// GWS Calendar filter routes (pattern: /gws/{action}/:label — matches /gws/validate/:label)
router.get('/gws/calendars/:label', (req, res) => proxyToAgent(req, res, 'GET', `/gws/calendars/${encodeURIComponent(req.params.label)}`, null));
router.get('/gws/calendar-filter/:label', (req, res) => proxyToAgent(req, res, 'GET', `/gws/calendar-filter/${encodeURIComponent(req.params.label)}`, null));
router.post('/gws/calendar-filter/:label', (req, res) => proxyToAgent(req, res, 'POST', `/gws/calendar-filter/${encodeURIComponent(req.params.label)}`, req.body));

module.exports = router;
