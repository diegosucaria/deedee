const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const MCP_CONFIG_PATH = path.resolve(__dirname, '../../../../mcp_config.json');

// GET /v1/mcp - List servers (Proxies agent status logic or reads config)
router.get('/', (req, res) => {
    try {
        if (!fs.existsSync(MCP_CONFIG_PATH)) {
            return res.json({});
        }
        const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'));

        // Sanitize check: Don't expose passwords directly? 
        // The UI needs to show *something*. Let's mask sensitive Env vars.
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
        res.status(500).json({ error: error.message });
    }
});

// POST /v1/mcp - Add/Update a server
router.post('/', (req, res) => {
    try {
        const { name, transport, url, token, command, args, env, disabled } = req.body;

        if (!name) return res.status(400).json({ error: "Name is required" });

        let config = {};
        if (fs.existsSync(MCP_CONFIG_PATH)) {
            config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'));
        }

        const newEntry = {
            transport: transport || 'sse',
            disabled: disabled || false
        };

        if (newEntry.transport === 'sse') {
            if (!url) return res.status(400).json({ error: "URL is required for SSE" });
            newEntry.url = url;
            newEntry.env = env || {};
            // Special handling for HA_TOKEN abuse used in mcp-manager logic
            if (token) {
                newEntry.env.HA_TOKEN = token;
            }
        } else {
            // Stdio
            if (!command) return res.status(400).json({ error: "Command is required for stdio" });
            newEntry.command = command;
            newEntry.args = args || [];
            newEntry.env = env || {};
        }

        config[name] = newEntry;

        fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));

        // Optional: Trigger Agent Reload?
        // Agent watches file? Or we need to tell it?
        // mcp-manager.js loads on init. It doesn't seem to watch.
        // But the user might restart manually or we implement a reload endpoint on Agent.

        res.json({ success: true, config: newEntry });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
