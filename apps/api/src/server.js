require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { authMiddleware } = require('./auth');
const chatRouter = require('./chat');
const audioChatRouter = require('./audio-chat');
const briefingRouter = require('./briefing');
const cityImageRouter = require('./city-image');
const dashboardRouter = require('./dashboard');

const app = express();
const port = process.env.PORT || 3001;

// Increase body limit to support large audio/image payloads (matches Agent)
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// Public Routes (No Auth)
app.use('/health', require('./routes/health'));

// Protected V1 Routes
app.use('/v1', (req, res, next) => {
    return authMiddleware(req, res, next);
});
app.use('/v1', dashboardRouter); // Dashboard routes (journal, tasks, facts)
app.use('/v1/chat', chatRouter);
app.use('/v1/chat', audioChatRouter); // Mounts POST /v1/chat/audio
app.use('/v1/briefing', briefingRouter);
app.use('/v1/city-image', cityImageRouter);
app.use('/v1/whatsapp', require('./whatsapp'));
app.use('/v1/slack', require('./slack'));
app.use('/v1/gsuite', require('./gsuite'));
app.use('/v1/live', require('./live'));
app.use('/v1/vaults', require('./vaults'));
app.use('/v1/people', require('./routes/people'));
app.use('/v1/settings', require('./routes/settings'));
app.use('/v1/config', require('./routes/config'));
app.use('/v1/aliases', require('./routes/aliases'));
app.use('/v1/goals', require('./routes/goals'));
app.use('/v1/facts', require('./routes/facts'));
app.use('/v1/backups', require('./routes/backups'));
app.use('/v1/dj', require('./routes/dj'));
app.use('/v1/autopilot', require('./routes/autopilot'));
app.use('/v1/skills', require('./routes/skills'));
app.use('/v1/browser-secrets', require('./routes/secrets'));
app.use('/v1/mcp', require('./routes/mcp'));

// --- Socket.io Proxy to Interfaces ---
// Proxies WebSocket + HTTP transport directly to interfaces:5000.
// This bypasses the Next.js rewrite layer (which can't handle WS upgrades)
// and avoids Traefik forward-auth CSRF cookie spam from polling.
const { createProxyMiddleware } = require('http-proxy-middleware');
const INTERFACES_URL = process.env.INTERFACES_URL || 'http://interfaces:5000';

const socketProxy = createProxyMiddleware({
    target: INTERFACES_URL,
    ws: true,
    changeOrigin: true,
    pathFilter: '/socket.io',
});
app.use(socketProxy);

const http = require('http');
// Protected Log Stream
app.get('/v1/logs/:container', authMiddleware, (req, res) => {
    // Stream from Supervisor
    const container = req.params.container;
    const tail = req.query.tail || 100;

    // Disable timeouts for streaming
    req.setTimeout(0);
    res.setTimeout(0);

    // We can't rely on generic SUPERVISOR_URL being set in API service if it's not.
    // Docker compose says api has AGENT_URL. Supervisor is at http://supervisor:4000
    const supervisorHost = 'supervisor';
    const supervisorPort = 4000;

    // Build query string from all params
    const query = new URLSearchParams(req.query).toString();
    const path = `/logs/${container}${query ? `?${query}` : ''}`;

    const options = {
        hostname: supervisorHost,
        port: supervisorPort,
        path: path,
        method: 'GET',
        headers: {
            'x-supervisor-token': process.env.SUPERVISOR_TOKEN
        }
    };

    const proxyReq = http.request(options, (proxyRes) => {
        // Forward Status
        res.writeHead(proxyRes.statusCode, {
            ...proxyRes.headers,
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        proxyRes.pipe(res, { end: true });

        // Handle upstream disconnect
        proxyRes.on('close', () => {
            if (!res.finished) res.end();
        });
    });

    // Handle upstream socket errors (ECONNRESET, etc)
    proxyReq.on('error', (e) => {
        // Only log if it's not a standard client disconnect
        if (e.code !== 'ECONNRESET') {
            console.error(`[API] Log Proxy Error: ${e.message} (${e.code})`);
        }
        if (!res.headersSent) res.status(502).json({ error: 'Failed to connect to Supervisor' });
    });

    // Handle client disconnect
    req.on('close', () => {
        proxyReq.destroy();
    });

    // Set a timeout?
    // proxyReq.setTimeout(0); // Disable timeout?

    proxyReq.end();
});

if (require.main === module) {
    const server = http.createServer(app);
    // Attach socket.io proxy to handle WebSocket upgrade requests
    server.on('upgrade', socketProxy.upgrade);
    server.listen(port, () => {
        console.log(`API Service listening on port ${port}`);
    });
}

module.exports = { app };
