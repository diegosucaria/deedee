const express = require('express');
const { ConfigService } = require('../services/config-service');

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
                'communication_dry_run', 'notification_channel',
                'provider:xai', 'chatModel', 'visionModel',
                'slack_monitored_channels'
            ];
            if (!ALLOWED_KEYS.includes(key)) {
                return res.status(400).json({ error: 'Invalid config key' });
            }

            if (!key || value === undefined) {
                return res.status(400).json({ error: 'Missing key or value' });
            }

            const jsonValue = JSON.stringify(value);

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
                agent.settings[key] = value;
            }

            // Notify via Socket (Broadcast via Interfaces service)
            if (agent.interface) {
                // fire and forget
                agent.interface.broadcast('entity:update', { type: 'setting', key, value }).catch(console.error);
            }

            res.json({ success: true, key, value });
        } catch (error) {
            console.error('[Settings] POST Failed:', error);
            res.status(500).json({ error: error.message });
        }
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
