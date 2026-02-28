const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// Helper for proxying
const proxyRequest = async (req, res, method, path) => {
    try {
        const url = `${AGENT_URL}${path}`;
        const config = { method, url, params: req.query };

        const response = await axios(config);
        res.json(response.data);
    } catch (error) {
        console.error(`[API] DJ Proxy Error (${method} ${path}):`, error.message);
        const status = error.response ? error.response.status : 502;
        const data = error.response ? error.response.data : { error: 'Agent unavailable' };
        res.status(status).json(data);
    }
};

// GET /v1/dj/vinyls
// Maps to Agent: GET /internal/dj/vinyls
router.get('/vinyls', (req, res) => proxyRequest(req, res, 'GET', '/internal/dj/vinyls'));

// POST /v1/dj/vinyls/upload  
// Maps to Agent: POST /internal/dj/vinyls/upload
router.post('/vinyls/upload', async (req, res) => {
    try {
        const url = `${AGENT_URL}/internal/dj/vinyls/upload`;
        const response = await axios.post(url, req.body, {
            maxBodyLength: 10 * 1024 * 1024, // 10MB
            headers: { 'Content-Type': 'application/json' }
        });
        res.json(response.data);
    } catch (error) {
        console.error('[API] DJ Upload Proxy Error:', error.message);
        const status = error.response ? error.response.status : 502;
        const data = error.response ? error.response.data : { error: 'Agent unavailable' };
        res.status(status).json(data);
    }
});

// PUT /v1/dj/vinyls/:id
// Maps to Agent: PUT /internal/dj/vinyls/:id
router.put('/vinyls/:id', async (req, res) => {
    try {
        const url = `${AGENT_URL}/internal/dj/vinyls/${encodeURIComponent(req.params.id)}`;
        const response = await axios.put(url, req.body, {
            headers: { 'Content-Type': 'application/json' }
        });
        res.json(response.data);
    } catch (error) {
        console.error('[API] DJ Update Proxy Error:', error.message);
        const status = error.response ? error.response.status : 502;
        const data = error.response ? error.response.data : { error: 'Agent unavailable' };
        res.status(status).json(data);
    }
});

module.exports = router;
