const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// 1. Get Ephemeral Token
router.post('/token', async (req, res) => {
    try {
        const response = await axios.post(`${AGENT_URL}/live/token`);
        res.json(response.data);
    } catch (error) {
        console.error('[API] Live Token Error:', error.message);
        const status = error.response ? error.response.status : 502;
        res.status(status).json({ error: 'Failed to get live token' });
    }
});

// 2. Execute Backend Tools
router.post('/tools/execute', async (req, res) => {
    try {
        const { name, args } = req.body;
        const response = await axios.post(`${AGENT_URL}/tools/execute`, { name, args });
        res.json(response.data);
    } catch (error) {
        console.error(`[API] Live Tool Error (${req.body.name}):`, error.message);
        const status = error.response ? error.response.status : 502;
        res.status(status).json({ error: 'Tool execution failed', details: error.message });
    }
});

module.exports = router;
