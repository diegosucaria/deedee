const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

const proxyRequest = async (req, res, method, path, { largeBody = false } = {}) => {
    try {
        const url = `${AGENT_URL}${path}`;
        const config = { method, url, params: req.query };
        if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) && req.body) {
            config.data = req.body;
            config.headers = { 'Content-Type': 'application/json' };
        }
        if (largeBody) {
            config.maxBodyLength = 15 * 1024 * 1024;
            config.maxContentLength = 15 * 1024 * 1024;
        }
        const response = await axios(config);
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Wardrobe Proxy Error (${method} ${path}):`, error.message);
        const status = error.response ? error.response.status : 502;
        const data = error.response ? error.response.data : { error: 'Agent unavailable' };
        res.status(status).json(data);
    }
};

// Garments
router.get('/garments', (req, res) => proxyRequest(req, res, 'GET', '/internal/wardrobe/garments'));
router.post('/garments/upload', (req, res) => proxyRequest(req, res, 'POST', '/internal/wardrobe/garments/upload', { largeBody: true }));
router.get('/garments/:id', (req, res) => proxyRequest(req, res, 'GET', `/internal/wardrobe/garments/${encodeURIComponent(req.params.id)}`));
router.put('/garments/:id', (req, res) => proxyRequest(req, res, 'PUT', `/internal/wardrobe/garments/${encodeURIComponent(req.params.id)}`));
router.delete('/garments/:id', (req, res) => proxyRequest(req, res, 'DELETE', `/internal/wardrobe/garments/${encodeURIComponent(req.params.id)}`));
router.post('/garments/:id/confirm-brand', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/garments/${encodeURIComponent(req.params.id)}/confirm-brand`));
router.post('/garments/:id/merge', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/garments/${encodeURIComponent(req.params.id)}/merge`));
router.post('/garments/:id/reenrich', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/garments/${encodeURIComponent(req.params.id)}/reenrich`, { largeBody: true }));
router.post('/garments/:id/generate-image', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/garments/${encodeURIComponent(req.params.id)}/generate-image`, { largeBody: true }));
router.post('/garments/:id/duplicate', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/garments/${encodeURIComponent(req.params.id)}/duplicate`, { largeBody: true }));
router.post('/garments/:id/outfits', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/garments/${encodeURIComponent(req.params.id)}/outfits`));

// Outfits
router.get('/outfits', (req, res) => proxyRequest(req, res, 'GET', '/internal/wardrobe/outfits'));
router.post('/outfits/recommend', (req, res) => proxyRequest(req, res, 'POST', '/internal/wardrobe/outfits/recommend'));
router.get('/outfits/:id', (req, res) => proxyRequest(req, res, 'GET', `/internal/wardrobe/outfits/${encodeURIComponent(req.params.id)}`));
router.post('/outfits/:id/like', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/outfits/${encodeURIComponent(req.params.id)}/like`));
router.post('/outfits/:id/variations', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/outfits/${encodeURIComponent(req.params.id)}/variations`));
router.delete('/outfits/:id', (req, res) => proxyRequest(req, res, 'DELETE', `/internal/wardrobe/outfits/${encodeURIComponent(req.params.id)}`));
router.put('/outfits/:id', (req, res) => proxyRequest(req, res, 'PUT', `/internal/wardrobe/outfits/${encodeURIComponent(req.params.id)}`));
router.post('/outfits/visualize', (req, res) => proxyRequest(req, res, 'POST', '/internal/wardrobe/outfits/visualize', { largeBody: true }));
router.post('/outfits/critique', (req, res) => proxyRequest(req, res, 'POST', '/internal/wardrobe/outfits/critique', { largeBody: true }));

// Trips
router.get('/trips', (req, res) => proxyRequest(req, res, 'GET', '/internal/wardrobe/trips'));
router.get('/trips/:id', (req, res) => proxyRequest(req, res, 'GET', `/internal/wardrobe/trips/${encodeURIComponent(req.params.id)}`));
router.post('/trips/pack', (req, res) => proxyRequest(req, res, 'POST', '/internal/wardrobe/trips/pack'));
router.post('/trips/:id/start', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/trips/${encodeURIComponent(req.params.id)}/start`));
router.post('/trips/:id/complete', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/trips/${encodeURIComponent(req.params.id)}/complete`));
router.put('/trips/:id/capsule', (req, res) => proxyRequest(req, res, 'PUT', `/internal/wardrobe/trips/${encodeURIComponent(req.params.id)}/capsule`));
router.post('/trips/:id/capsule/add', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/trips/${encodeURIComponent(req.params.id)}/capsule/add`, { largeBody: true }));
router.post('/trips/:id/capsule/remove', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/trips/${encodeURIComponent(req.params.id)}/capsule/remove`));

// Shopping
router.get('/shopping', (req, res) => proxyRequest(req, res, 'GET', '/internal/wardrobe/shopping'));
router.post('/shopping', (req, res) => proxyRequest(req, res, 'POST', '/internal/wardrobe/shopping'));
router.post('/shopping/:id/purchased', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/shopping/${encodeURIComponent(req.params.id)}/purchased`));
router.post('/shopping/:id/dismiss', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/shopping/${encodeURIComponent(req.params.id)}/dismiss`));
router.post('/shopping/:id/reference-image', (req, res) => proxyRequest(req, res, 'POST', `/internal/wardrobe/shopping/${encodeURIComponent(req.params.id)}/reference-image`));

// Profile
router.get('/profile', (req, res) => proxyRequest(req, res, 'GET', '/internal/wardrobe/profile'));
router.put('/profile', (req, res) => proxyRequest(req, res, 'PUT', '/internal/wardrobe/profile'));
router.post('/profile/reference-selfie', (req, res) => proxyRequest(req, res, 'POST', '/internal/wardrobe/profile/reference-selfie', { largeBody: true }));

module.exports = router;
