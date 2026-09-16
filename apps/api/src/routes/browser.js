const express = require('express');
const axios = require('axios');

const router = express.Router();
const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// Live browser view. The /browser page reads status on first render and
// presses Start here; frames and input travel over the socket through the
// interfaces service. The global axios interceptor adds the internal token.
const forward = async (res, fn) => {
    try {
        const response = await fn();
        res.json(response.data);
    } catch (error) {
        const status = error.response?.status || 500;
        const body = error.response?.data || { error: `Failed to reach Agent: ${error.message}` };
        res.status(status).json(body);
    }
};

// GET /v1/browser/status -> { running, url, agentBusy, watchers }
router.get('/status', (req, res) => forward(res, () => axios.get(`${AGENT_URL}/internal/browser/live/status`)));

// POST /v1/browser/start -> launches Chromium through the MCP server
router.post('/start', (req, res) => forward(res, () => axios.post(`${AGENT_URL}/internal/browser/live/start`, {})));

module.exports = router;
