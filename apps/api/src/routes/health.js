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
        // Two seconds. One second called a busy agent "unreachable" while it
        // was answering chats. It must stay under the dashboard's own three
        // seconds for this route, or a dead agent is blamed on the API.
        await axios.get(`${agentUrl}/health`, { timeout: 2000 });
        health.checks.agent = 'ok';
    } catch (e) {
        health.checks.agent = 'unreachable';
        health.status = 'degraded';
    }

    res.json(health);
});

module.exports = router;
