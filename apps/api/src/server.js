require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { authMiddleware } = require('./auth');
const chatRouter = require('./chat');
const briefingRouter = require('./briefing');
const cityImageRouter = require('./city-image');
const dashboardRouter = require('./dashboard');

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());
app.use(cors());

// Health Check (Public)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'api' });
});

// Protected V1 Routes
app.use('/v1', authMiddleware);
app.use('/v1', dashboardRouter); // Dashboard routes (journal, tasks, facts)
app.use('/v1/chat', chatRouter);
app.use('/v1/briefing', briefingRouter);
app.use('/v1/briefing', briefingRouter);
app.use('/v1/city-image', cityImageRouter);

// Proxy System Logs (Stream)
const http = require('http');
app.get('/v1/logs/:container', (req, res) => {
    // Stream from Supervisor
    const container = req.params.container;
    const tail = req.query.tail || 100;

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
        method: 'GET'
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
    });

    proxyReq.on('error', (e) => {
        console.error(`[API] Log Proxy Error: ${e.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Failed to connect to Supervisor' });
    });

    // Handle client disconnect
    req.on('close', () => {
        proxyReq.destroy();
    });

    proxyReq.end();
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`API Service listening on port ${port}`);
    });
}

module.exports = { app };
