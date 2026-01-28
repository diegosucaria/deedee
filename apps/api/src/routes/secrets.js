const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

// Proxy /v1/browser-secrets -> AGENT /internal/browser-secrets
// We use simple proxy middleware to forward GET and POST
router.use('/', createProxyMiddleware({
    target: AGENT_URL,
    changeOrigin: true, // required for virtual hosted sites
    pathRewrite: {
        '^/$': '/internal/browser-secrets', // Match root (stripped path)
        '^/(.*)': '/internal/browser-secrets/$1' // Match subpaths if any
    },
    onProxyReq: (proxyReq, req, res) => {
        // Optional: Log proxying
        // console.log(`[API Proxy] Forwarding ${req.method} ${req.originalUrl} -> ${proxyReq.path}`);
    }
}));

module.exports = router;
