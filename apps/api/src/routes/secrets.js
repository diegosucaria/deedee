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
        // Essential: Fix body parsing for proxy
        // Since express.json() consumes the stream, we must restream it for the proxy
        if (req.body && Object.keys(req.body).length > 0) {
            const bodyData = JSON.stringify(req.body);
            // set header
            proxyReq.setHeader('Content-Type', 'application/json');
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            // stream the data
            proxyReq.write(bodyData);
            proxyReq.end();
        }
    }
}));

module.exports = router;
