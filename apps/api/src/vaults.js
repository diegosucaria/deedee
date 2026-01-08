const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const router = express.Router();
const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// Proxy /v1/vaults/* to Agent Service
// Auth is already handled by Gateway's server.js mounting this under /v1 (which uses authMiddleware)

// We need to rewrite the path because the router is mounted at /v1/vaults
// but the Agent also expects /v1/vaults ?
// In apps/agent/src/server.js: app.use('/v1/vaults', createVaultRouter(agent));
// So request to Gateway: /v1/vaults/foo
// Should go to Agent: /v1/vaults/foo
// Proxy middleware usually strips mount point if not configured otherwise. 
// But here we are inside a Router(). 

// Let's look at live.js pattern.
// If live.js uses http-proxy-middleware, I'll copy exact config.

const proxy = createProxyMiddleware({
    target: AGENT_URL,
    changeOrigin: true,
    pathRewrite: {
        // If mounted at /v1/vaults, strict proxying matches downstream.
        // No rewrite needed if names match.
    },
    onProxyReq: (proxyReq, req, res) => {
        // Optional: Log proxying
    },
    onError: (err, req, res) => {
        console.error('[API] Vault Proxy Error:', err);
        res.status(502).json({ error: 'Agent Service Unavailable' });
    }
});

router.use('/', proxy);

module.exports = router;
