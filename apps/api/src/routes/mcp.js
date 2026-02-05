const express = require('express');
const router = express.Router();

// GET /v1/mcp - List servers (Proxy to Agent)
router.get('/', async (req, res) => {
    try {
        const agentUrl = process.env.AGENT_URL || 'http://agent:3000';
        const fetch = (await import('node-fetch')).default;

        const response = await fetch(`${agentUrl}/internal/mcp/config`);
        if (!response.ok) {
            throw new Error(`Agent returned ${response.status}`);
        }

        const config = await response.json();

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
        console.error('[API] Failed to fetch MCP config from Agent:', error);
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
        const fetch = (await import('node-fetch')).default;

        let config = {};
        try {
            const getRes = await fetch(`${agentUrl}/internal/mcp/config`);
            if (getRes.ok) config = await getRes.json();
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
        const saveRes = await fetch(`${agentUrl}/internal/mcp/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        if (!saveRes.ok) throw new Error('Failed to save config to Agent');

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
        const fetch = (await import('node-fetch')).default;

        // 1. Fetch
        let config = {};
        const getRes = await fetch(`${agentUrl}/internal/mcp/config`);
        if (getRes.ok) config = await getRes.json();

        // 2. Delete
        if (config[name]) {
            delete config[name];

            // 3. Save
            const saveRes = await fetch(`${agentUrl}/internal/mcp/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            if (!saveRes.ok) throw new Error('Failed to save config to Agent');
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
