const express = require('express');
const axios = require('axios');
const router = express.Router();

const interfacesUrl = process.env.INTERFACES_URL || 'http://interfaces:5000';

// Proxy helper
const proxyRequest = async (req, res, method, path, data) => {
    try {
        const url = `${interfacesUrl}${path}`;
        const response = await axios({ method, url, data, params: req.query });
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

router.post('/disconnect', (req, res) => proxyRequest(req, res, 'POST', '/whatsapp/disconnect'));

module.exports = router;
