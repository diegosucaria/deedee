const express = require('express');
const router = express.Router();
const axios = require('axios');

// GET /v1/mcp - List servers (Proxy to Agent)
router.get('/', async (req, res) => {
    try {
        const agentUrl = process.env.AGENT_URL || 'http://agent:3000';

        const response = await axios.get(`${agentUrl}/internal/mcp/config`);
        const config = response.data;

        // Security: Mask Secrets
        const sanitized = {};
        for (const [name, cfg] of Object.entries(config)) {
            sanitized[name] = { ...cfg };
            if (sanitized[name].env) {
                for (const k in sanitized[name].env) {
                    if (k.includes('TOKEN') || k.includes('KEY') || k.includes('PASSWORD')) {
                        sanitized[name].env[k] = '********';
                    }
                }
            }
        }
        res.json(sanitized);
    } catch (error) {
        console.error('[API] Failed to fetch MCP config from Agent:', error.message);
        res.status(500).json({ error: 'Failed to fetch configuration', details: error.message });
    }
});

// POST /v1/mcp - Add/Update a server
router.post('/', async (req, res) => {
    try {
        const { name, transport, url, token, command, args, env, disabled } = req.body;

        if (!name) return res.status(400).json({ error: "Name is required" });

        // 1. Fetch current config
        const agentUrl = process.env.AGENT_URL || 'http://agent:3000';
        let config = {};
        try {
            const getRes = await axios.get(`${agentUrl}/internal/mcp/config`);
            config = getRes.data;
        } catch (e) {
            console.warn('[API] Could not fetch existing config, starting fresh');
        }

        // 2. Prepare new entry
        const newEntry = {
            transport: transport || 'sse',
            disabled: disabled || false
        };

        if (newEntry.transport === 'sse') {
            if (!url) return res.status(400).json({ error: "URL is required for SSE" });
            newEntry.url = url;
            newEntry.env = env || {};
            if (token) {
                newEntry.env.HA_TOKEN = token;
            }
        } else {
            if (!command) return res.status(400).json({ error: "Command is required for stdio" });
            newEntry.command = command;
            newEntry.args = args || [];
            newEntry.env = env || {};
        }

        config[name] = newEntry;

        // 3. Save back to Agent
        await axios.post(`${agentUrl}/internal/mcp/config`, config);

        res.json({ success: true, config: newEntry });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /v1/mcp/:name - Delete a server
router.delete('/:name', async (req, res) => {
    try {
        const name = req.params.name;
        if (!name) return res.status(400).json({ error: "Name required" });

        const agentUrl = process.env.AGENT_URL || 'http://agent:3000';

        // 1. Fetch
        let config = {};
        try {
            const getRes = await axios.get(`${agentUrl}/internal/mcp/config`);
            config = getRes.data;
        } catch (e) {
            return res.status(500).json({ error: "Could not fetch config from agent" });
        }

        // 2. Delete
        if (config[name]) {
            delete config[name];

            // 3. Save
            await axios.post(`${agentUrl}/internal/mcp/config`, config);
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /v1/mcp/reload - Force reload of MCP connections
router.post('/reload', async (req, res) => {
    try {
        const agentUrl = process.env.AGENT_URL || 'http://agent:3000';
        await axios.post(`${agentUrl}/internal/mcp/reload`);
        res.json({ success: true });
    } catch (error) {
        console.error('[API] Failed to reload MCP:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
