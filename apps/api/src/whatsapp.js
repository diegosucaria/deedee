const express = require('express');
const axios = require('axios');
const router = express.Router();

const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';

// Proxy helper
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
        console.error(`[API] WhatsApp Proxy Error (${method} ${path}):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(502).json({ error: 'Interfaces Service unavailable' });
        }
    }
};

router.get('/status', (req, res) => proxyRequest(req, res, 'GET', '/whatsapp/status'));
router.get('/qr', (req, res) => proxyRequest(req, res, 'GET', '/whatsapp/qr')); // (Actually status returns QR, maybe this endpoint is redundant or specific for pure image?)
// Status endpoint in interfaces service returns { status, qr (base64) }. Ideally we use that.
// But if we want a dedicated endpoint later, fine. For now, rely on status.

router.post('/connect', (req, res) => proxyRequest(req, res, 'POST', '/whatsapp/connect', req.body));

router.post('/disconnect', (req, res) => proxyRequest(req, res, 'POST', '/whatsapp/disconnect', req.body));

router.get('/contacts', (req, res) => proxyRequest(req, res, 'GET', '/whatsapp/contacts'));

router.get('/resolve', (req, res) => proxyRequest(req, res, 'GET', '/whatsapp/resolve'));

router.post('/repair', (req, res) => proxyRequest(req, res, 'POST', '/whatsapp/repair', req.body));

// Session state, the two live probes and the store counts. The /diagnose chat
// command was the only way to see this; now the Settings page can show it too.
router.post('/diagnose', (req, res) => proxyRequest(req, res, 'POST', '/whatsapp/diagnose', req.body));

router.get('/profile', (req, res) => proxyRequest(req, res, 'GET', '/whatsapp/profile'));

module.exports = router;
