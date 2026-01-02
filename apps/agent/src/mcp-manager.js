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

    async getTools() {
        const allTools = [];
        this.toolMap.clear(); // Refresh cache

        for (const [name, client] of this.clients.entries()) {
            try {
                const result = await client.listTools();
                if (result && result.tools) {
                    const mappedTools = result.tools.map(t => ({
                        name: t.name,
                        description: t.description,
                        parameters: t.inputSchema // MCP uses 'inputSchema', Gemini uses 'parameters' (JSON Schema)
                    }));

                    // Store reference and populate cache
                    mappedTools.forEach(t => {
                        t.serverName = name;
                        this.toolMap.set(t.name, { name, client });
                    });

                    allTools.push(...mappedTools);
                }
            } catch (err) {
                console.error(`[MCP] Failed to list tools for ${name}:`, err);
            }
        }
        return allTools;
    }

    async callTool(name, args) {
        // Linear lookup removed. Using cache.
        const owner = this.toolMap.get(name);

        if (!owner) {
            throw new Error(`Tool ${name} not found in any MCP server.`);
        }

        const result = await owner.client.callTool({
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

    async init() {
        if (!fs.existsSync(this.configPath)) {
            console.warn(`[MCP] Config not found at ${this.configPath}. Skipping.`);
            return;
        }

        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));

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
                    transport = new StdioClientTransport({
                        command: serverConfig.command,
                        args: serverConfig.args || [],
                        env: env
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
                const result = await client.listTools();
                if (result && result.tools) {
                    const mappedTools = result.tools.map(t => ({
                        name: t.name,
                        description: t.description,
                        parameters: t.inputSchema // MCP uses 'inputSchema', Gemini uses 'parameters' (JSON Schema)
                    }));

                    // Store reference and populate cache
                    mappedTools.forEach(t => {
                        t.serverName = name;
                        this.toolMap.set(t.name, { name, client });
                    });

                    this.toolCache.push(...mappedTools);
                }
            } catch (err) {
                console.error(`[MCP] Failed to list tools for ${name}:`, err);
            }
        }
        console.log(`[MCP] Tool cache refreshed. ${this.toolCache.length} tools found.`);
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
            return await this._callClient(retryOwner.client, name, args);
        }

        return await this._callClient(owner.client, name, args);
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
