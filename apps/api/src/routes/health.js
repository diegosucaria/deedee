const express = require('express');
const axios = require('axios');

const router = express.Router();
const agentUrl = process.env.AGENT_URL || 'http://agent:3000';

router.get('/', async (req, res) => {
    const health = {
        service: 'api',
        status: 'ok',
        timestamp: new Date().toISOString(),
        checks: {
            agent: 'unknown'
        }
    };

    // Check Agent Reachability
    try {
        await axios.get(`${agentUrl}/health`, { timeout: 1000 });
        health.checks.agent = 'ok';
    } catch (e) {
        health.checks.agent = 'unreachable';
        health.status = 'degraded';
    }

    res.json(health);
});

module.exports = router;
