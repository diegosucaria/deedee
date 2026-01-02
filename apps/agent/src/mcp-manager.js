const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const path = require('path');
const fs = require('fs');

class MCPManager {
    constructor(configPath = '../mcp_config.json') {
        this.clients = new Map(); // serverName -> Client
        this.toolMap = new Map(); // toolName -> { name: string, client: Client }
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
    }

    async getTools() {
        const allTools = [];

        for (const [name, client] of this.clients.entries()) {
            try {
                const result = await client.listTools();
                if (result && result.tools) {
                    // Tag tools with server name to route them later? 
                    // Or we utilize the fact that tool names should be unique or namespaced.
                    // For now, we assume unique names or prefixing if needed.
                    // We map them to the format Gemini expects if different available, 
                    // but MCP tools format is standard openapi-like.
                    // Gemini SDK expects: { name, description, parameters }

                    const mappedTools = result.tools.map(t => ({
                        name: t.name,
                        description: t.description,
                        parameters: t.inputSchema // MCP uses 'inputSchema', Gemini uses 'parameters' (JSON Schema)
                    }));

                    // Store a reference to which client owns this tool
                    mappedTools.forEach(t => t.serverName = name);

                    allTools.push(...mappedTools);
                }
            } catch (err) {
                console.error(`[MCP] Failed to list tools for ${name}:`, err);
            }
        }
        return allTools;
    }

    async callTool(name, args) {
        // Find which client owns this tool.
        // Since we don't have a map of tool->client, we can query all or cache it.
        // For simplicity, we query all or keep a cache from getTools() step.
        // Let efficient lookup:

        // RE-OPTIMIZATION: We should maintain a `toolMap` populated during getTools()
        // But since Agent calls getTools() once at session start (or per turn), 
        // we can rely on `getTools` having just run? No, stateless agent.

        // We need to re-fetch or cache. 
        // Let's iterate clients and ask them to call it. 
        // Better: keep a local cache in the Manager instance if it persists?
        // Agent is persistent, onMessage is per-turn. Manager is persistent in Agent.

        for (const [serverName, client] of this.clients.entries()) {
            // We can optimistically try to call? No, that throws error.
            // We need to know which server has it.
            // Check listTools again? (Expensive)
            // Let's cache it on init?
        }

        // IMPLEMENTATION FIX: Cache tools on init/refresh
        // For this pass, I will perform a lookup because I haven't implemented caching yet.
        // Ideally, we catch the toolMap.

        // Let's assume we pass the serverName? No, LLM doesn't know it.

        // Fallback: Check my cache.
        // ...
        // Since I cannot rewrite Init right now easily without complexity, 
        // I will use a simple "Find owner" method.

        const owner = await this._findToolOwner(name);
        if (!owner) {
            throw new Error(`Tool ${name} not found in any MCP server.`);
        }

        const result = await owner.client.callTool({
            name: name,
            arguments: args
        });

        // Flatten result for Gemini
        // MCP result: { content: [ { type: 'text', text: '...' } ] }
        // Gemini expects plain object or specific structure?
        // My Agent expects { ... } object to stringify or pass through.

        // Let's return the simplified result
        if (result.content && result.content.length > 0) {
            // Return text content
            const text = result.content.map(c => c.text).join('\n');
            return { output: text };
        }
        return result;
    }

    async _findToolOwner(toolName) {
        // Linear search through connected clients
        for (const [name, client] of this.clients.entries()) {
            const tools = await client.listTools();
            if (tools.tools.some(t => t.name === toolName)) {
                return { name, client };
            }
        }
        return null;
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
