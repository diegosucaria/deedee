const express = require('express');
const axios = require('axios');
const router = express.Router();

const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';

// Proxy helper (same pattern as whatsapp.js)
const proxyRequest = async (req, res, method, path, data) => {
    try {
        const url = `${interfacesUrl}${path}`;
        const headers = {
            'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}`,
            'Content-Type': 'application/json'
        };
        const response = await axios({ method, url, data, params: req.query, headers });
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Slack Proxy Error (${method} ${path}):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(502).json({ error: 'Interfaces Service unavailable' });
        }
    }
};

router.get('/status', (req, res) => proxyRequest(req, res, 'GET', '/slack/status'));
router.post('/credentials', (req, res) => proxyRequest(req, res, 'POST', '/slack/credentials', req.body));
router.delete('/credentials', (req, res) => proxyRequest(req, res, 'DELETE', '/slack/credentials'));
router.get('/search', (req, res) => proxyRequest(req, res, 'GET', '/slack/search'));
router.get('/history', (req, res) => proxyRequest(req, res, 'GET', '/slack/history'));
router.get('/channels', (req, res) => proxyRequest(req, res, 'GET', '/slack/channels'));
router.get('/users', (req, res) => proxyRequest(req, res, 'GET', '/slack/users'));

module.exports = router;
