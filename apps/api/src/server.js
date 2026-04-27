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
// Production must set WEB_ORIGIN to the UI origin so CORS allows credentials
// (cookie auth) on cross-origin socket.io connects. Default is local dev only.
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000';

// Increase body limit to support large audio/image payloads (matches Agent)
app.use(express.json({ limit: '50mb' }));
// CORS scoped to the UI origin so the _forward_auth cookie can ride along
// on cross-origin socket.io connects. Wildcard origin + credentials is
// rejected by browsers, so the origin must be explicit. Non-browser callers
// (iOS Shortcuts etc.) authenticate via Bearer token and don't need CORS.
app.use(cors({ origin: WEB_ORIGIN, credentials: true }));

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
app.use('/v1/wardrobe', require('./routes/wardrobe'));
app.use('/v1/autopilot', require('./routes/autopilot'));
app.use('/v1/skills', require('./routes/skills'));
app.use('/v1/browser-secrets', require('./routes/secrets'));
app.use('/v1/mcp', require('./routes/mcp'));

// --- Socket.io Proxy to Interfaces ---
// Auth model:
//   - Traefik's google-auth middleware gates this path on the reverse proxy
//     and stamps `X-Forwarded-User` on authenticated requests.
//   - We require that header here as defense-in-depth: if the API container
//     is ever reached without going through Traefik (direct port exposure,
//     misconfigured router), the proxy refuses to relay.
//   - We inject DEEDEE_API_TOKEN into the upstream URL so Interfaces accepts
//     via its query-param token path. The token never reaches the browser.
//   - Polling stays disabled on the client (transports: ['websocket']) so a
//     successful WS upgrade is the only HTTP request that hits Traefik per
//     connection — no forward-auth cookie spam.
//   - Escape hatch: setting DISABLE_SOCKET_AUTH_GATE=1 skips the header check
//     so plain `docker-compose up` self-hosters (no Traefik forward-auth) can
//     reach `/socket.io`. Only safe on a trusted LAN — it removes the only
//     auth layer in front of the socket proxy.
const { createProxyMiddleware } = require('http-proxy-middleware');
const INTERFACES_URL = process.env.INTERFACES_URL || 'http://interfaces:5000';
const SOCKET_AUTH_GATE_DISABLED = process.env.DISABLE_SOCKET_AUTH_GATE === '1';

if (SOCKET_AUTH_GATE_DISABLED) {
    console.warn('[API] DISABLE_SOCKET_AUTH_GATE=1 — /socket.io reachable without X-Forwarded-User. Use only on trusted networks.');
}

const injectUpstreamToken = (path) => {
    const token = process.env.DEEDEE_API_TOKEN;
    if (!token) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}token=${encodeURIComponent(token)}`;
};

const socketProxy = createProxyMiddleware({
    target: INTERFACES_URL,
    ws: true,
    changeOrigin: true,
    pathRewrite: injectUpstreamToken,
});

const socketAuthGate = (req, res, next) => {
    if (SOCKET_AUTH_GATE_DISABLED) return next();
    if (!req.headers['x-forwarded-user']) {
        return res.status(401).json({ error: 'Socket.io requires authenticated session via reverse proxy' });
    }
    next();
};

app.use('/socket.io', socketAuthGate, socketProxy);

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
    // Express middleware does not run for raw WebSocket `upgrade` events,
    // so we gate on `X-Forwarded-User` here in addition to the HTTP middleware
    // before delegating to the proxy.
    server.on('upgrade', (req, socket, head) => {
        if (!req.url || !req.url.startsWith('/socket.io')) {
            socket.destroy();
            return;
        }
        if (!SOCKET_AUTH_GATE_DISABLED && !req.headers['x-forwarded-user']) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        socketProxy.upgrade(req, socket, head);
    });
    server.listen(port, () => {
        console.log(`API Service listening on port ${port}`);
    });
}

module.exports = { app };
