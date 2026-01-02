const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

router.post('/', async (req, res) => {
    try {
        const { message, source, chatId } = req.body;

        if (!message || !chatId) {
            return res.status(400).json({ error: 'Missing required fields: message, chatId' });
        }

        const payload = {
            content: message,
            source: source || 'api',
            metadata: { chatId: chatId },
            role: 'user',
            type: 'text'
        };

        // Forward to Agent /chat (Synchronous)
        console.log(`[API] Forwarding message from ${chatId} to Agent (Synchronous)...`);
        const response = await axios.post(`${AGENT_URL}/chat`, payload);

        // response.data = { replies: [...] }
        res.json({ success: true, agentResponse: response.data });

    } catch (error) {
        console.error('[API] Failed to forward to agent:', error.message);
        const status = error.response ? error.response.status : 502;
        res.status(status).json({ error: 'Failed to communicate with Agent', details: error.message });
    }
});

module.exports = router;
