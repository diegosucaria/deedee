const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const path = require('path');
const fs = require('fs');

class MCPManager {
    constructor(configPath = '../mcp_config.json') {
        this.clients = new Map(); // serverName -> Client
        this.toolCache = [];       // Array of all tools (Gemini format)
        this.toolMap = new Map();  // toolName -> { name: string, client: Client }
        this.configPath = path.resolve(__dirname, configPath);
    }

    // ... (init method remains same)

    // Duplicate getTools was here.

    // Duplicate getTools and callTool were here. Removed to avoid confusion with the bottom ones.

    async init() {
        // Close existing connections to prevent leaks during reload
        if (this.clients.size > 0) {
            await this.close();
        }

        // Robust Merge Logic
        let userConfig = {};

        // 1. Load User Config (Persistent)
        if (fs.existsSync(this.configPath)) {
            try {
                userConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
            } catch (e) {
                console.error(`[MCP] Failed to parse user config at ${this.configPath}:`, e.message);
                // Backup corrupt file?
                try { fs.copyFileSync(this.configPath, `${this.configPath}.bak`); } catch (ex) { }
            }
        }

        // 2. Load Default Config (Image/Repo)
        let defaultConfig = {};
        const candidates = [
            path.resolve(__dirname, '../mcp_config.json'), // Relative to src
            path.resolve('/app/mcp_config.json'),          // Docker root
            path.resolve(process.cwd(), 'mcp_config.json') // Current working directory
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                try {
                    defaultConfig = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
                    // console.log(`[MCP] Loaded default config from ${candidate}`);
                    break;
                } catch (e) {
                    console.warn(`[MCP] Failed to parse default config at ${candidate}:`, e.message);
                }
            }
        }

        // 3. Merge: Default + User (User overrides Default)
        // We want to ensure any NEW servers in Default appear in User
        // But if User deleted a Default server, we might re-add it? 
        // For now, simpler is better: "Ensure all default keys exist".
        let dirty = false;

        // A. Copy Defaults if missing
        for (const [key, val] of Object.entries(defaultConfig)) {
            if (!userConfig[key]) {
                console.log(`[MCP] Merging new default server: ${key}`);
                userConfig[key] = val;
                dirty = true;
            }
        }

        // 4. Save if changed (or if file didn't exist)
        if (dirty || !fs.existsSync(this.configPath)) {
            try {
                fs.writeFileSync(this.configPath, JSON.stringify(userConfig, null, 2));
                console.log(`[MCP] Updated persistent config at ${this.configPath}`);
            } catch (e) {
                console.error(`[MCP] Failed to save merged config:`, e.message);
            }
        }

        // Use the merged (or loaded) config
        const config = userConfig;
        this.config = config;

        for (const [name, serverConfig] of Object.entries(config)) {
            if (serverConfig.disabled) continue;

            try {
                console.log(`[MCP] Connecting to server: ${name}...`);

                // Resolve Env Vars
                const env = { ...process.env };
                if (serverConfig.env) {
                    for (const [k, v] of Object.entries(serverConfig.env)) {
                        if (v.startsWith('${') && v.endsWith('}')) {
                            const varName = v.slice(2, -1);
                            env[k] = process.env[varName] || '';
                        } else {
                            env[k] = v;
                        }
                    }
                }

                // SPECIAL HANDLING: Home Assistant
                if (name === 'homeassistant') {
                    // Map standard variables for 'ha-mcp' package (and others that use HASS_*)
                    if (env.HA_URL) {
                        env.HASS_URL = env.HA_URL;
                        env.HOMEASSISTANT_URL = env.HA_URL; // Required by ha-mcp
                    }
                    if (env.HA_TOKEN) {
                        env.HASS_TOKEN = env.HA_TOKEN;
                        env.HOMEASSISTANT_TOKEN = env.HA_TOKEN; // Required by ha-mcp
                    }

                    // Also derive WebSocket URL for 'mcp-server-home-assistant' legacy support or fallback
                    if (env.HA_URL && !env.HOME_ASSISTANT_WEB_SOCKET_URL) {
                        try {
                            const haUrl = new URL(env.HA_URL);
                            const proto = haUrl.protocol === 'https:' ? 'wss:' : 'ws:';
                            // Construct standard WS path
                            const wsUrl = `${proto}//${haUrl.host}${haUrl.pathname.replace(/\/$/, '')}/api/websocket`;
                            env.HOME_ASSISTANT_WEB_SOCKET_URL = wsUrl;
                            console.log(`[MCP] Derived HOME_ASSISTANT_WEB_SOCKET_URL: ${wsUrl}`);
                        } catch (e) {
                            console.warn(`[MCP] Failed to derive WS URL from HA_URL: ${env.HA_URL}`, e);
                        }
                    }
                    // Map Token for 'mcp-server-home-assistant'
                    if (env.HA_TOKEN && !env.HOME_ASSISTANT_API_TOKEN) {
                        env.HOME_ASSISTANT_API_TOKEN = env.HA_TOKEN;
                    }
                }

                let transport;
                if (serverConfig.transport === 'sse') {
                    // Interpolate URL variables if needed
                    let urlStr = serverConfig.url;
                    if (urlStr.includes('${')) {
                        // Simple replacement for now, reusing the 'env' logic or just matching?
                        // We have the resolved 'env' object from above loop.
                        // But that env loop puts vars INTO 'env' object.
                        // We need values from process.env (or keys in that env block).

                        // Let's do a replace against process.env
                        urlStr = urlStr.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
                    }

                    // SSE Transport
                    const url = new URL(urlStr);
                    console.log(`[MCP] Debug: Connecting to ${urlStr}`);
                    console.log(`[MCP] Debug: Token present? ${!!env.HA_TOKEN}`);
                    if (env.HA_TOKEN) console.log(`[MCP] Debug: Token length: ${env.HA_TOKEN.length}`);

                    transport = new SSEClientTransport(url, {
                        eventSourceInit: {
                            headers: {
                                "Authorization": `Bearer ${env.HA_TOKEN}`
                            }
                        }
                    });
                } else {
                    // Default: Stdio Transport
                    // Robust CWD Resolution: Relative to config directory, not process.cwd()
                    // Robust Command: Sanitize absolute paths that might be invalid in this environment
                    let command = serverConfig.command;
                    if (command === '/usr/local/bin/node' || command === '/usr/bin/node') command = 'node';
                    if (command === '/usr/bin/python3' || command === '/usr/local/bin/python3') command = 'python3';
                    if (command === 'node') command = process.execPath; // Use current runtime

                    // Robust CWD Resolution
                    const configDir = path.dirname(this.configPath);
                    let resolvedCwd = serverConfig.cwd
                        ? path.resolve(configDir, serverConfig.cwd)
                        : configDir;

                    // Fix: usage of relative paths 'no longer works' if the config file was moved to /app/data
                    // Strategy: If resolvedCwd doesn't exist, try resolving relative to process.cwd() or common roots
                    if (!fs.existsSync(resolvedCwd)) {
                        console.warn(`[MCP] CWD ${resolvedCwd} not found. Attempting auto-repair...`);

                        // Try 1: Relative to process.cwd() (The Agent working directory)
                        const candidate1 = path.resolve(process.cwd(), serverConfig.cwd);

                        // Try 2: Hardcoded Docker Path (Fix for "../../packages" becoming "/packages")
                        // If we are in /app/apps/agent, then ../../packages is /app/packages.
                        // But configDir might be /app/data.
                        const candidate2 = path.resolve('/app/packages', path.basename(serverConfig.cwd));

                        if (fs.existsSync(candidate1)) {
                            console.log(`[MCP] Auto-repaired CWD to: ${candidate1}`);
                            resolvedCwd = candidate1;
                        } else if (fs.existsSync(candidate2)) {
                            console.log(`[MCP] Auto-repaired CWD to: ${candidate2}`);
                            resolvedCwd = candidate2;
                        } else {
                            console.warn(`[MCP] Failed to repair CWD. Spawning might fail.`);
                        }
                    }

                    console.log(`[MCP] Spawning ${name}: cmd=${command}, cwd=${resolvedCwd}`);

                    transport = new StdioClientTransport({
                        command: command,
                        args: serverConfig.args || [],
                        env: env,
                        cwd: resolvedCwd
                    });
                }

                const client = new Client({
                    name: "DeedeeClient",
                    version: "1.0.0",
                }, {
                    capabilities: {}
                });

                await client.connect(transport);
                this.clients.set(name, client);
                console.log(`[MCP] Connected to ${name}`);

            } catch (error) {
                console.error(`[MCP] Failed to connect to ${name}:`, error);
            }
        }

        // Initial Tool Cache Population
        await this._refreshToolCache();
    }

    async _refreshToolCache() {
        this.toolCache = [];
        this.toolMap.clear();

        for (const [name, client] of this.clients.entries()) {
            try {
                const namespace = this.config?.[name]?.namespace;
                const prefix = namespace ? `${namespace}_` : '';

                const result = await client.listTools();
                if (result && result.tools) {
                    const mappedTools = result.tools.map(t => {
                        let safeName = `${prefix}${t.name}`;

                        // Sanitize to Gemini's allowed characters (a-z, A-Z, 0-9, _, ., :, -)
                        safeName = safeName.replace(/[^a-zA-Z0-9_.\:\-]/g, '_');

                        // Must start with a letter or underscore
                        if (!/^[a-zA-Z_]/.test(safeName)) {
                            safeName = '_' + safeName;
                        }

                        // Gemini allows max 64 characters
                        if (safeName.length > 64) {
                            const crypto = require('crypto');
                            const hash = crypto.createHash('md5').update(t.name).digest('hex').substring(0, 8);
                            // 64 total: 55 for truncated name + 1 for underscore + 8 for hash = 64
                            safeName = safeName.substring(0, 55) + '_' + hash;
                        }

                        // GWS tools require userId as a path param but don't default it.
                        // Inject hint so the model always passes userId: "me".
                        let description = t.description;
                        if (name.startsWith('gws_')) {
                            description += ' IMPORTANT: Always pass params.userId = "me" for any method that requires a userId parameter.';
                        }

                        return {
                            name: safeName,
                            originalName: t.name,
                            description,
                            parameters: t.inputSchema // MCP uses 'inputSchema', Gemini uses 'parameters'
                        };
                    });

                    // Store reference and populate cache
                    mappedTools.forEach(t => {
                        // Deduplicate to avoid Gemini crashing on "Duplicate function declaration found"
                        if (this.toolMap.has(t.name)) {
                            console.warn(`[MCP] Warning: Duplicate tool name detected: ${t.name}. Skipping.`);
                            return;
                        }
                        t.serverName = name;
                        this.toolMap.set(t.name, { name, client, originalName: t.originalName });
                        this.toolCache.push(t);
                    });
                }
            } catch (err) {
                console.error(`[MCP] Failed to list tools for ${name}:`, err);
            }
        }
        console.log(`[MCP] Tool cache refreshed. ${this.toolCache.length} tools found.`);
    }

    async getStatus() {
        const statuses = [];
        // Read config to know all potential servers
        let config = {};
        try {
            if (fs.existsSync(this.configPath)) {
                config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
            }
        } catch (e) {
            console.error('[MCP] Failed to read config for status:', e);
        }

        const configuredNames = Object.keys(config);

        for (const name of configuredNames) {
            if (config[name].disabled) {
                statuses.push({ name, status: 'disabled' });
                continue;
            }

            const client = this.clients.get(name);
            if (client) {
                // Check if actually connected? The map implies it.
                // We could ping? For now assume connected if in map.
                statuses.push({ name, status: 'connected', type: config[name].transport });
            } else {
                statuses.push({ name, status: 'disconnected' });
            }
        }
        return statuses;
    }

    async getTools() {
        // Return cached tools. If empty, try one refresh (unless truly empty)
        if (this.toolCache.length === 0 && this.clients.size > 0) {
            await this._refreshToolCache();
        }
        return this.toolCache;
    }

    async callTool(name, args) {
        // Linear lookup removed. Using cache.
        const owner = this.toolMap.get(name);

        if (!owner) {
            // Try refresh once just in case
            await this._refreshToolCache();
            const retryOwner = this.toolMap.get(name);
            if (!retryOwner) {
                throw new Error(`Tool ${name} not found in any MCP server.`);
            }
            return await this._callClient(retryOwner.client, retryOwner.originalName || name, args);
        }

        return await this._callClient(owner.client, owner.originalName || name, args);
    }

    async _callClient(client, name, args) {
        const result = await client.callTool({
            name: name,
            arguments: args
        });

        // Let's return the simplified result
        if (result.content && result.content.length > 0) {
            // Return text content
            const text = result.content.map(c => c.text).join('\n');
            return { output: text };
        }
        return result;
    }



    async close() {
        console.log('[MCP] Closing connections...');
        for (const [name, client] of this.clients.entries()) {
            try {
                if (client.transport && typeof client.transport.close === 'function') {
                    await client.transport.close();
                } else if (typeof client.close === 'function') {
                    await client.close();
                }
                console.log(`[MCP] Closed connection to ${name}`);
            } catch (e) {
                console.warn(`[MCP] Error closing ${name}:`, e.message);
            }
        }
        this.clients.clear();
    }
}

module.exports = { MCPManager };
