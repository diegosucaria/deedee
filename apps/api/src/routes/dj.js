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

module.exports = router;
