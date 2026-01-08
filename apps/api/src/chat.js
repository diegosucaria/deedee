const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';
const http = require('http'); // For streaming proxy

router.post('/', async (req, res) => {
    try {
        const { message, source, chatId } = req.body;

        if (!message || !chatId) {
            return res.status(400).json({ error: 'Missing required fields: message, chatId' });
        }

        const payload = {
            content: message,
            source: source || 'api',
            metadata: {
                ...(req.body.metadata || {}), // Pass through frontend metadata (location, etc)
                chatId: chatId
            },
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

// GET /:id/files - Proxy file upload to Agent
router.post('/:id/files', (req, res) => {
    const { id } = req.params;
    console.log(`[API] Proxying file upload for chat ${id} to Agent...`);

    // Parse AGENT_URL
    const agentUrlObj = new URL(AGENT_URL);
    const options = {
        hostname: agentUrlObj.hostname,
        port: agentUrlObj.port || 80,
        path: `/v1/chat/${encodeURIComponent(id)}/files`,
        method: 'POST',
        headers: {
            ...req.headers,
            host: agentUrlObj.host // Update Host header
        }
    };

    // Remove connection headers to avoid conflicts
    delete options.headers['connection'];
    delete options.headers['content-length']; // Let pipe handle it or keeping it is fine if exact? 
    // Actually, for multipart, content-length is important.
    // But Request piping handles it?
    // Let's keep headers mostly intact, except Host.

    // We must pass the Content-Type with boundary!

    const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (e) => {
        console.error(`[API] File Proxy Error: ${e.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Failed to connect to Agent for upload' });
    });

    req.pipe(proxyReq, { end: true });
});

module.exports = router;
