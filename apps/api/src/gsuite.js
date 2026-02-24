const express = require('express');
const axios = require('axios');
const router = express.Router();

const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';

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
        console.error(`[API] GSuite Proxy Error (${method} ${path}):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(502).json({ error: 'Interfaces Service unavailable' });
        }
    }
};

router.get('/accounts', (req, res) => proxyRequest(req, res, 'GET', '/gsuite/accounts'));
router.post('/auth-url', (req, res) => proxyRequest(req, res, 'POST', '/gsuite/auth-url', req.body));
router.post('/auth', (req, res) => proxyRequest(req, res, 'POST', '/gsuite/auth', req.body));
router.post('/disconnect', (req, res) => proxyRequest(req, res, 'POST', '/gsuite/disconnect', req.body));
router.put('/accounts/:email/label', (req, res) => proxyRequest(req, res, 'PUT', `/gsuite/accounts/${encodeURIComponent(req.params.email)}/label`, req.body));

module.exports = router;
