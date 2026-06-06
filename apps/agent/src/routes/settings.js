const express = require('express');
const { ConfigService } = require('../services/config-service');

/**
 * Find the MCP calendar tool name for a GWS account label.
 * In compact mode the tool is "{namespace}_calendar".
 * Refreshes the tool cache once if not found (handles startup timing).
 */
async function findGWSCalendarTool(mcp, safeLabel) {
    if (!mcp || !mcp.toolMap) return null;

    // First attempt: search current cache
    let found = _scanToolMap(mcp.toolMap, safeLabel);
    if (found) return found;

    // Tool not found — refresh cache once (handles startup race / MCP reconnect)
    if (typeof mcp._refreshToolCache === 'function') {
        await mcp._refreshToolCache();
        found = _scanToolMap(mcp.toolMap, safeLabel);
    }
    return found;
}

function _scanToolMap(toolMap, safeLabel) {
    for (const [toolName, entry] of toolMap.entries()) {
        if (entry.name === `gws_${safeLabel}` && toolName.toLowerCase().includes('calendar')) {
            return toolName;
        }
    }
    return null;
}

/** Loose validation that a string is an IPv4 or IPv6 address (guards against echo services returning HTML). */
function isValidIp(s) {
    if (typeof s !== 'string') return false;
    const v = s.trim();
    // IPv4
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) {
        return v.split('.').every((o) => o.length <= 3 && Number(o) <= 255);
    }
    // IPv6 (loose — hex groups separated by colons)
    if (v.includes(':') && /^[0-9a-fA-F:]+$/.test(v)) return true;
    return false;
}

const EGRESS_IP_TTL_MS = 60 * 1000;

function createSettingsRouter(agent) {
    const router = express.Router();

    // GET /internal/settings
    // Returns { key: value, key2: value2 }
    router.get('/', (req, res) => {
        try {
            const stmt = agent.db.db.prepare('SELECT key, value FROM agent_settings');
            const rows = stmt.all();

            const settings = rows.reduce((acc, row) => {
                try {
                    acc[row.key] = JSON.parse(row.value);
                } catch (e) {
                    acc[row.key] = row.value; // Fallback for non-JSON
                }
                return acc;
            }, {});

            res.json(settings);
        } catch (error) {
            console.error('[Settings] GET Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /internal/settings
    // Body: { key: string, value: any, category?: string }
    router.post('/', (req, res) => {
        try {
            const { key, value, category = 'general' } = req.body;

            const ALLOWED_KEYS = [
                'owner_phone', 'owner_name', 'search_strategy', 'voice_settings',
                'communication_dry_run', 'communication_style', 'notification_channel',
                'provider:xai', 'chatModel', 'visionModel',
                'slack_monitored_channels', 'proactive_run_probability'
            ];
            if (!ALLOWED_KEYS.includes(key)) {
                return res.status(400).json({ error: 'Invalid config key' });
            }

            if (!key || value === undefined) {
                return res.status(400).json({ error: 'Missing key or value' });
            }

            let storedValue = value;
            // Proactive loop run probability: must be a number in [0, 1].
            if (key === 'proactive_run_probability') {
                const n = Number(value);
                if (!Number.isFinite(n) || n < 0 || n > 1) {
                    return res.status(400).json({ error: 'proactive_run_probability must be a number between 0 and 1' });
                }
                storedValue = n;
            }

            const jsonValue = JSON.stringify(storedValue);

            const stmt = agent.db.db.prepare(`
                INSERT INTO agent_settings (key, value, category, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    category = excluded.category,
                    updated_at = CURRENT_TIMESTAMP
            `);

            stmt.run(key, jsonValue, category);

            console.log(`[Settings] Updated ${key}`);

            // Update In-Memory Cache
            if (agent.settings) {
                agent.settings[key] = storedValue;
            }

            // Notify via Socket (Broadcast via Interfaces service)
            if (agent.interface) {
                // fire and forget
                agent.interface.broadcast('entity:update', { type: 'setting', key, value: storedValue }).catch(console.error);
            }

            res.json({ success: true, key, value });
        } catch (error) {
            console.error('[Settings] POST Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /internal/settings/egress-ip
    // The Pi's public outbound IP — used to restrict the Gemini API key to this
    // host (Cloud Console → API key → Application restrictions → IP addresses).
    // Detected from the agent process, whose egress IP is what reaches Gemini.
    let egressIpCache = null; // { ip, fetchedAt: number }

    router.get('/egress-ip', async (req, res) => {
        const now = Date.now();
        const force = req.query.refresh === '1' || req.query.refresh === 'true';

        if (!force && egressIpCache && now - egressIpCache.fetchedAt < EGRESS_IP_TTL_MS) {
            return res.json({
                ip: egressIpCache.ip,
                fetchedAt: new Date(egressIpCache.fetchedAt).toISOString(),
                cached: true,
            });
        }

        // Ordered echo services; each resolves to a bare IP string. Tried in turn.
        const providers = [
            async () => {
                const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
                if (!r.ok) throw new Error(`ipify ${r.status}`);
                return (await r.json()).ip;
            },
            async () => {
                const r = await fetch('https://icanhazip.com', { signal: AbortSignal.timeout(4000) });
                if (!r.ok) throw new Error(`icanhazip ${r.status}`);
                return await r.text();
            },
            async () => {
                const r = await fetch('https://ifconfig.co/ip', {
                    signal: AbortSignal.timeout(4000),
                    headers: { 'User-Agent': 'curl/8' },
                });
                if (!r.ok) throw new Error(`ifconfig.co ${r.status}`);
                return await r.text();
            },
        ];

        let lastErr = null;
        for (const provider of providers) {
            try {
                const candidate = (await provider())?.trim();
                if (isValidIp(candidate)) {
                    egressIpCache = { ip: candidate, fetchedAt: now };
                    return res.json({ ip: candidate, fetchedAt: new Date(now).toISOString(), cached: false });
                }
            } catch (e) {
                lastErr = e;
            }
        }

        console.warn('[Settings] Egress IP lookup failed:', lastErr?.message || 'no valid IP returned');
        res.status(502).json({ error: 'Could not determine egress IP' });
    });


    // POST /internal/settings/gws/upload
    router.post('/gws/upload', async (req, res) => {
        try {
            const { label, accountEmail, credentials } = req.body;
            if (!label || !accountEmail || !credentials) {
                return res.status(400).json({ error: 'Missing label, accountEmail or credentials' });
            }

            const safeLabel = encodeURIComponent(label.toLowerCase().replace(/[^a-z0-9]/g, '-'));

            const fs = require('fs');
            const path = require('path');

            let dataDir = process.env.DATA_DIR || '/app/data';
            if (!fs.existsSync(dataDir)) {
                dataDir = path.resolve(__dirname, '../../../../data'); // Adjust if needed
                if (!fs.existsSync(dataDir)) {
                    fs.mkdirSync(dataDir, { recursive: true });
                }
            }

            const credsPath = path.join(dataDir, `gws-credentials-${safeLabel}.json`);

            let parsedCreds;
            try {
                parsedCreds = JSON.parse(credentials);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid JSON credentials' });
            }

            fs.writeFileSync(credsPath, JSON.stringify(parsedCreds, null, 2));
            console.log(`[Settings] Saved GWS credentials for ${label} to ${credsPath}`);

            if (agent.mcp) {
                const configPath = agent.mcp.configPath;
                let userConfig = {};
                if (fs.existsSync(configPath)) {
                    try { userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { }
                }

                userConfig[`gws_${safeLabel}`] = {
                    command: "gws",
                    args: ["mcp", "-s", "all", "--tool-mode", "compact"],
                    namespace: safeLabel,
                    env: {
                        "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE": credsPath,
                        "GOOGLE_WORKSPACE_CLI_ACCOUNT": accountEmail.trim()
                    }
                };

                fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2));
                console.log(`[Settings] Updated mcp_config.json with gws_${safeLabel}`);

                // Trigger reload
                agent.mcp.init().catch(e => console.error('[Settings] MCP reload failed:', e));
            }

            res.json({ success: true, message: `Configured GWS for ${label}` });
        } catch (error) {
            console.error('[Settings] GWS Upload Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // ─── GWS OAuth Routes ───────────────────────────────────────────────

    const GWS_OAUTH_SCOPES = [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://mail.google.com/',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/contacts',
        'https://www.googleapis.com/auth/contacts.other.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/presentations',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/forms',
        'https://www.googleapis.com/auth/chat.messages',
        'https://www.googleapis.com/auth/admin.directory.user.readonly',
    ];

    function getDataDir() {
        const fs = require('fs');
        const path = require('path');
        let dataDir = process.env.DATA_DIR || '/app/data';
        if (!fs.existsSync(dataDir)) {
            dataDir = path.resolve(__dirname, '../../../../data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
        }
        return dataDir;
    }

    function getOAuthClientPath() {
        const path = require('path');
        return path.join(getDataDir(), 'gws-oauth-client.json');
    }

    function loadOAuthClient() {
        const fs = require('fs');
        const clientPath = getOAuthClientPath();
        if (!fs.existsSync(clientPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(clientPath, 'utf8'));
        } catch (e) {
            return null;
        }
    }

    // Save MCP config entry for a GWS account (shared by upload & OAuth flows)
    function saveGWSMCPEntry(agent, safeLabel, credsPath, accountEmail) {
        const fs = require('fs');
        if (!agent.mcp) return;

        const configPath = agent.mcp.configPath;
        let userConfig = {};
        if (fs.existsSync(configPath)) {
            try { userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { }
        }

        userConfig[`gws_${safeLabel}`] = {
            command: "gws",
            args: ["mcp", "-s", "all", "--tool-mode", "compact"],
            namespace: safeLabel,
            env: {
                "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE": credsPath,
                "GOOGLE_WORKSPACE_CLI_ACCOUNT": accountEmail.trim()
            }
        };

        fs.writeFileSync(configPath, JSON.stringify(userConfig, null, 2));
        console.log(`[Settings] Updated mcp_config.json with gws_${safeLabel}`);

        agent.mcp.init().catch(e => console.error('[Settings] MCP reload failed:', e));
    }

    // POST /internal/settings/gws/oauth/client — Save OAuth client credentials (one-time)
    router.post('/gws/oauth/client', async (req, res) => {
        try {
            const { clientId, clientSecret, redirectUri } = req.body;
            if (!clientId || !clientSecret || !redirectUri) {
                return res.status(400).json({ error: 'Missing clientId, clientSecret, or redirectUri' });
            }

            const fs = require('fs');
            const clientData = { clientId, clientSecret, redirectUri };
            fs.writeFileSync(getOAuthClientPath(), JSON.stringify(clientData, null, 2));
            console.log(`[Settings] Saved GWS OAuth client config`);

            res.json({ success: true });
        } catch (error) {
            console.error('[Settings] Save OAuth Client Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /internal/settings/gws/oauth/client — Check if OAuth client is configured
    router.get('/gws/oauth/client', (req, res) => {
        try {
            const client = loadOAuthClient();
            if (!client) {
                return res.json({ configured: false });
            }

            // Mask client_id: show first 8 and last 4 chars
            const id = client.clientId || '';
            const maskedId = id.length > 12
                ? `${id.slice(0, 8)}...${id.slice(-4)}`
                : id;

            res.json({ configured: true, clientId: maskedId, redirectUri: client.redirectUri });
        } catch (error) {
            console.error('[Settings] Get OAuth Client Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /internal/settings/gws/oauth/url — Generate OAuth authorization URL
    router.get('/gws/oauth/url', (req, res) => {
        try {
            const { label, email } = req.query;
            if (!label || !email) {
                return res.status(400).json({ error: 'Missing label or email query params' });
            }

            const client = loadOAuthClient();
            if (!client) {
                return res.status(400).json({ error: 'OAuth client not configured. Upload client_secret.json first.' });
            }

            const state = Buffer.from(JSON.stringify({ label, email })).toString('base64url');

            const params = new URLSearchParams({
                client_id: client.clientId,
                redirect_uri: client.redirectUri,
                response_type: 'code',
                scope: GWS_OAUTH_SCOPES.join(' '),
                access_type: 'offline',
                prompt: 'consent',
                state,
                login_hint: email,
            });

            const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
            res.json({ url });
        } catch (error) {
            console.error('[Settings] Generate OAuth URL Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /internal/settings/gws/oauth/exchange — Exchange auth code for tokens
    router.post('/gws/oauth/exchange', async (req, res) => {
        try {
            const { code, label, accountEmail } = req.body;
            if (!code || !label || !accountEmail) {
                return res.status(400).json({ error: 'Missing code, label, or accountEmail' });
            }

            const client = loadOAuthClient();
            if (!client) {
                return res.status(400).json({ error: 'OAuth client not configured' });
            }

            // Exchange auth code for tokens
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code,
                    client_id: client.clientId,
                    client_secret: client.clientSecret,
                    redirect_uri: client.redirectUri,
                    grant_type: 'authorization_code',
                }).toString(),
            });

            const tokenData = await tokenResponse.json();

            if (!tokenResponse.ok || !tokenData.refresh_token) {
                console.error('[Settings] Token exchange failed:', tokenData);
                return res.status(400).json({
                    error: tokenData.error_description || tokenData.error || 'Token exchange failed. No refresh_token received.'
                });
            }

            console.log(`[Settings] OAuth token exchange successful for ${accountEmail}`);

            // Write credentials in GWS CLI format
            const fs = require('fs');
            const path = require('path');
            const safeLabel = encodeURIComponent(label.toLowerCase().replace(/[^a-z0-9]/g, '-'));
            const credsPath = path.join(getDataDir(), `gws-credentials-${safeLabel}.json`);

            const credentials = {
                type: 'authorized_user',
                client_id: client.clientId,
                client_secret: client.clientSecret,
                refresh_token: tokenData.refresh_token,
            };

            fs.writeFileSync(credsPath, JSON.stringify(credentials, null, 2));
            console.log(`[Settings] Saved GWS OAuth credentials for ${label} to ${credsPath}`);

            // Update MCP config and reload
            saveGWSMCPEntry(agent, safeLabel, credsPath, accountEmail);

            res.json({ success: true, message: `Authenticated GWS for ${label}` });
        } catch (error) {
            console.error('[Settings] OAuth Exchange Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /internal/settings/gws/validate/:label — Check if GWS credentials are still valid
    router.get('/gws/validate/:label', async (req, res) => {
        try {
            const { label } = req.params;
            const fs = require('fs');
            const path = require('path');
            const safeLabel = encodeURIComponent(label.toLowerCase().replace(/[^a-z0-9]/g, '-'));
            const credsPath = path.join(getDataDir(), `gws-credentials-${safeLabel}.json`);

            if (!fs.existsSync(credsPath)) {
                return res.json({ valid: false, error: 'credentials_missing' });
            }

            let creds;
            try {
                creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            } catch (e) {
                return res.json({ valid: false, error: 'credentials_corrupt' });
            }

            if (!creds.refresh_token || !creds.client_id || !creds.client_secret) {
                return res.json({ valid: false, error: 'credentials_incomplete' });
            }

            // Try to exchange the refresh token for an access token
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: creds.client_id,
                    client_secret: creds.client_secret,
                    refresh_token: creds.refresh_token,
                    grant_type: 'refresh_token',
                }).toString(),
            });

            const tokenData = await tokenResponse.json();

            if (!tokenResponse.ok || tokenData.error) {
                console.warn(`[Settings] GWS token validation failed for ${label}:`, tokenData.error || tokenResponse.status);
                return res.json({
                    valid: false,
                    error: tokenData.error || 'token_refresh_failed',
                    errorDescription: tokenData.error_description || null,
                });
            }

            res.json({ valid: true });
        } catch (error) {
            console.error('[Settings] GWS Validate Failed:', error);
            res.json({ valid: false, error: 'validation_error' });
        }
    });

    // ─── GWS Calendar Filter Routes ──────────────────────────────────
    // URL pattern: /gws/{action}/:label (matches existing /gws/validate/:label convention)

    // GET /internal/settings/gws/calendars/:label — List all calendars for an account
    router.get('/gws/calendars/:label', async (req, res) => {
        try {
            const safeLabel = req.params.label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            console.log(`[CalendarDiscovery] Starting discovery for "${safeLabel}"`);

            if (!agent.mcp) {
                console.error(`[CalendarDiscovery] MCP not initialized`);
                return res.status(503).json({ error: 'MCP not ready' });
            }

            // Find the calendar tool for this GWS account (async — retries with cache refresh)
            const toolName = await findGWSCalendarTool(agent.mcp, safeLabel);
            if (!toolName) {
                const availableTools = [...agent.mcp.toolMap.keys()].filter(t => t.includes('calendar'));
                const gwsServers = [...agent.mcp.toolMap.values()].map(e => e.name).filter(n => n.startsWith('gws_'));
                console.error(`[CalendarDiscovery] No calendar tool for "${safeLabel}". Calendar tools: [${availableTools}], GWS servers: [${[...new Set(gwsServers)]}]`);
                return res.status(404).json({ error: `No calendar tool found for account "${safeLabel}". Available GWS servers: ${[...new Set(gwsServers)].join(', ') || 'none'}` });
            }

            const toolEntry = agent.mcp.toolMap.get(toolName);
            // Log MCP server config to diagnose credential scoping (work vs personal)
            const serverConfig = agent.mcp.config?.[toolEntry?.name];
            const credsFile = serverConfig?.env?.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE || 'unknown';
            const configuredAccount = serverConfig?.env?.GOOGLE_WORKSPACE_CLI_ACCOUNT || 'unknown';
            console.log(`[CalendarDiscovery] Found tool: ${toolName} (server: ${toolEntry?.name}, creds: ${credsFile}, account: ${configuredAccount})`);

            // Call calendarList.list via MCP (unfiltered — bypass the filter for discovery)
            // GWS CLI compact mode expects: { resource, method, params }
            let result;
            try {
                result = await agent.mcp.callTool(toolName, {
                    resource: 'calendarList',
                    method: 'list',
                    params: { userId: 'me' }
                });
            } catch (mcpErr) {
                console.error(`[CalendarDiscovery] MCP callTool failed for ${safeLabel}:`, mcpErr.message);
                return res.status(503).json({ error: `Calendar service error: ${mcpErr.message}` });
            }

            // Log raw MCP response shape for debugging
            const resultKeys = result ? Object.keys(result) : [];
            console.log(`[CalendarDiscovery] Raw result keys: [${resultKeys}], output length: ${result?.output?.length || 0}`);

            const text = result?.output || (typeof result === 'string' ? result : JSON.stringify(result));
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                console.error(`[CalendarDiscovery] Response not JSON for ${safeLabel}:`, text?.substring(0, 500));
                return res.status(502).json({ error: text?.substring(0, 200) || 'Invalid response from calendar service' });
            }

            // Log parsed response shape
            const parsedKeys = parsed ? Object.keys(parsed) : [];
            console.log(`[CalendarDiscovery] Parsed keys: [${parsedKeys}], items count: ${parsed.items?.length ?? 'undefined'}`);

            // Check for API error responses from GWS CLI
            if (parsed.error) {
                console.error(`[CalendarDiscovery] GWS API error for ${safeLabel}:`, JSON.stringify(parsed.error));
                return res.status(502).json({ error: parsed.error.message || 'Calendar API returned an error' });
            }

            const items = parsed.items || [];
            if (items.length === 0) {
                // Log the full response (truncated) so we can see what the MCP returned
                console.warn(`[CalendarDiscovery] No items found for "${safeLabel}". Full response: ${text?.substring(0, 1000)}`);
            }

            // Log which account this data belongs to (primary calendar email = account identity)
            const primaryCal = items.find(c => c.primary);
            console.log(`[CalendarDiscovery] Returning ${items.length} calendars for "${safeLabel}" (primary: ${primaryCal?.id || 'none'})`);

            const calendars = items.map(cal => ({
                id: cal.id,
                summary: cal.summary || cal.id,
                primary: cal.primary || false,
                backgroundColor: cal.backgroundColor || null,
                accessRole: cal.accessRole || null,
            }));

            console.log(`[CalendarDiscovery] Returning ${calendars.length} calendars for "${safeLabel}"`);
            res.json({ calendars });
        } catch (error) {
            console.error('[CalendarDiscovery] Unexpected error:', error);
            res.status(500).json({ error: 'Failed to list calendars' });
        }
    });

    // GET /internal/settings/gws/calendar-filter/:label — Get current filter config
    router.get('/gws/calendar-filter/:label', (req, res) => {
        try {
            const safeLabel = req.params.label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            const filterKey = `gws_calendar_filter:${safeLabel}`;
            const setting = agent.db.getAgentSetting(filterKey);

            if (setting && setting.value) {
                res.json(setting.value);
            } else {
                res.json({ calendarIds: [], primaryOnly: true });
            }
        } catch (error) {
            console.error('[Settings] GWS Calendar Filter Get Failed:', error);
            res.status(500).json({ error: 'Failed to get calendar filter' });
        }
    });

    // POST /internal/settings/gws/calendar-filter/:label — Save calendar filter
    router.post('/gws/calendar-filter/:label', (req, res) => {
        try {
            const { calendarIds } = req.body;
            if (!Array.isArray(calendarIds)) {
                return res.status(400).json({ error: 'calendarIds must be an array' });
            }

            // Validate each calendar ID is a non-empty string
            const validIds = calendarIds.filter(id => typeof id === 'string' && id.length > 0 && id.length < 300);
            if (validIds.length !== calendarIds.length) {
                return res.status(400).json({ error: 'All calendarIds must be non-empty strings' });
            }

            const safeLabel = req.params.label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            const filterKey = `gws_calendar_filter:${safeLabel}`;
            const value = { calendarIds: validIds };

            agent.db.setAgentSetting(filterKey, value, 'gws');

            // Update in-memory cache
            if (agent.settings) {
                agent.settings[filterKey] = value;
            }

            // Broadcast update for real-time UI sync
            if (agent.interface) {
                agent.interface.broadcast('entity:update', { type: 'setting', key: filterKey, value }).catch(console.error);
            }

            console.log(`[Settings] Saved calendar filter for ${safeLabel}: ${validIds.length} calendars`);
            res.json({ success: true, calendarIds: validIds });
        } catch (error) {
            console.error('[Settings] GWS Calendar Filter Save Failed:', error);
            res.status(500).json({ error: 'Failed to save calendar filter' });
        }
    });

    // POST /internal/settings/tts/preview
    // Body: { text: string, voice: string }
    router.post('/tts/preview', async (req, res) => {
        try {
            const { text, voice } = req.body;
            if (!text || !voice) {
                return res.status(400).json({ error: 'Missing text or voice' });
            }

            const config = new ConfigService();

            console.log(`[Settings] Generating TTS preview for ${voice}: "${text}"`);

            // Ensure client is ready
            if (!agent.client) {
                const { GoogleGenAI } = await import('@google/genai');
                agent.client = new GoogleGenAI({ apiKey: agent.config.googleApiKey });
            }

            const modelName = config.getModel('TTS');

            const audioResponse = await agent.client.models.generateContent({
                model: modelName,
                contents: [{
                    parts: [{ text: `Please read this text naturally. Text: "${text}"` }]
                }],
                config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: voice
                            }
                        }
                    }
                }
            });

            config.logUsageFromResponse(agent.db, modelName, audioResponse, null, 'tts_preview');

            let audioData = null;
            let mimeType = 'audio/wav'; // Default

            if (audioResponse.candidates && audioResponse.candidates[0].content && audioResponse.candidates[0].content.parts) {
                const part = audioResponse.candidates[0].content.parts[0];
                if (part.inlineData) {
                    audioData = part.inlineData.data;
                    // Gemini returns raw PCM for audio modality usually, or whatever implementation detail.
                    // We will wrap it below.
                }
            }

            if (!audioData) {
                throw new Error('No audio returned from Gemini.');
            }

            // Wrap in WAV header (as we do in media executor)
            const { createWavHeader } = require('../utils/audio');
            const rawBuffer = Buffer.from(audioData, 'base64');
            const wavHeader = createWavHeader(rawBuffer.length, 24000, 1, 16);
            const wavBuffer = Buffer.concat([wavHeader, rawBuffer]);

            // Re-encode to base64
            const finalAudioBase64 = wavBuffer.toString('base64');

            console.log(`[Settings] TTS Generated. MimeType: ${mimeType}, Size: ${finalAudioBase64.length}`);

            return res.json({ success: true, audio_base64: finalAudioBase64, mimeType });

        } catch (error) {
            console.error('[Settings] TTS Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}

module.exports = { createSettingsRouter };
