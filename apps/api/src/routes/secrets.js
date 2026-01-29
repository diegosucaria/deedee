const express = require('express');

const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// Manual Proxy to avoid Body Parser stream conflicts with http-proxy-middleware
// Specifically for POST requests where express.json() has already consumed the stream
const forwardToAgent = async (req, res, method) => {
    try {
        const url = `${AGENT_URL}/internal/browser-secrets`;
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        if (method === 'POST') {
            options.body = JSON.stringify(req.body);
        }

        const agentRes = await fetch(url, options);

        // Forward status and body
        if (!agentRes.ok) {
            const text = await agentRes.text();
            try {
                const json = JSON.parse(text);
                return res.status(agentRes.status).json(json);
            } catch (e) {
                return res.status(agentRes.status).send(text);
            }
        }

        const data = await agentRes.json();
        res.json(data);
    } catch (e) {
        console.error('[API] Secrets Proxy Error:', e);
        res.status(500).json({ error: `Failed to connect to Agent: ${e.message}` });
    }
};

router.get('/', (req, res) => forwardToAgent(req, res, 'GET'));
router.post('/', (req, res) => forwardToAgent(req, res, 'POST'));

module.exports = router;
