const express = require('express');
const axios = require('axios');
const router = express.Router();

const agentUrl = process.env.AGENT_URL || 'http://localhost:3000';

// Helper for proxying GET
const proxyGet = async (req, res, path) => {
    try {
        const response = await axios.get(`${agentUrl}${path}`);
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Proxy Error (${path}):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ error: 'Agent unavailable' });
        }
    }
};

router.get('/journal', (req, res) => proxyGet(req, res, '/internal/journal'));

router.get('/journal/:date', (req, res) => proxyGet(req, res, `/internal/journal/${req.params.date}`));

router.get('/facts', (req, res) => proxyGet(req, res, '/internal/facts'));

router.get('/tasks', (req, res) => proxyGet(req, res, '/internal/tasks'));

router.post('/tasks/:id/cancel', async (req, res) => {
    try {
        const response = await axios.post(`${agentUrl}/internal/tasks/${req.params.id}/cancel`);
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Proxy Error (Cancel Task):`, error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ error: 'Agent unavailable' });
        }
    }
});

module.exports = router;
