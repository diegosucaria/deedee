const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// Helper for proxying
const proxyToAgent = async (req, res, method, path, data) => {
    try {
        const url = `${AGENT_URL}/internal/people${path}`;
        const config = {
            method,
            url,
            data,
            params: req.query,
            responseType: path.endsWith('/avatar') ? 'stream' : 'json'
        };

        const response = await axios(config);

        if (path.endsWith('/avatar')) {
            response.data.pipe(res);
        } else {
            res.json(response.data);
        }
    } catch (error) {
        console.error(`[API] Proxy Error (${method} ${path}):`, error.message);
        if (error.response) {

            // If it's a stream (avatar) and failed, we need to be careful not to crash res
            if (path.endsWith('/avatar')) {
                if (!res.headersSent) res.status(error.response.status).send('Avatar fetch failed');
                return;
            }

            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(502).json({ error: 'Agent Service unavailable' });
        }
    }
};

router.get('/', (req, res) => proxyToAgent(req, res, 'GET', '', null));
router.post('/', (req, res) => proxyToAgent(req, res, 'POST', '', req.body));
router.post('/learn', (req, res) => proxyToAgent(req, res, 'POST', '/learn', req.body));
router.get('/:id', (req, res) => proxyToAgent(req, res, 'GET', `/${req.params.id}`, null));
router.put('/:id', (req, res) => proxyToAgent(req, res, 'PUT', `/${req.params.id}`, req.body));
router.delete('/:id', (req, res) => proxyToAgent(req, res, 'DELETE', `/${req.params.id}`, null));
router.get('/:id/avatar', (req, res) => proxyToAgent(req, res, 'GET', `/${req.params.id}/avatar`, null));

module.exports = router;
