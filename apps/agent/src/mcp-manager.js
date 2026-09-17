const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const path = require('path');
const fs = require('fs');

// Google Workspace services the OAuth scopes in routes/settings.js can use.
// "-s all" loads ~25 services (admin, reseller, classroom...) whose tool
// descriptions go to the model on every request but can never succeed.
const GWS_MCP_SERVICES = 'gmail,calendar,drive,docs,sheets,slides';

// ${VAR} placeholders that may stay unset: the server gets a default (or
// nothing) instead of being disabled as "missing env".
const OPTIONAL_VARS = ['DATA_DIR', 'BROWSER_EXECUTABLE_PATH'];
const VAR_RE = /\$\{([^}]+)\}/g;

// The browser entry that replaces older saved ones. Its args name this file.
const BROWSER_LAUNCHER = 'browser-mcp.js';

// A stdio MCP child starts from these variables plus whatever its own config
// block names. Everything else the agent holds — every provider key — stays
// in the agent process. The list covers what the shipped servers need: a
// shell PATH, a home directory, locale and timezone, the TLS trust store for
// node and python, and the paths Chromium reads.
const MCP_BASE_ENV_VARS = [
    'PATH', 'HOME', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_ENV',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
    'PYTHONPATH', 'PYTHONHOME', 'PYTHONUNBUFFERED', 'VIRTUAL_ENV',
    'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
    'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
];

// "*" matches any run of characters; everything else is literal.
function _toolPatternToRegex(pattern) {
    const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}

class MCPManager {
    constructor(configPath = '../mcp_config.json') {
        this.clients = new Map(); // serverName -> Client
        this.toolCache = [];       // Array of all tools (Gemini format)
        this.toolMap = new Map();  // toolName -> { name: string, client: Client }
        this.configPath = path.resolve(__dirname, configPath);
        this._activeAbortControllers = new Set(); // one per in-flight call; each carries .toolName and .serverName
        this._pendingRestarts = new Set(); // servers to restart once their in-flight call ends
        this._restarting = new Map(); // serverName -> promise of the restart in progress
        this._slimSkipped = new Map(); // serverName -> [missingVars]
    }

    /** Defaults for placeholders that may stay unset. */
    _varDefaults() {
        return {
            DATA_DIR: process.env.DATA_DIR || (fs.existsSync('/app') && process.platform !== 'darwin' ? '/app/data' : path.join(process.cwd(), 'data')),
            BROWSER_EXECUTABLE_PATH: process.env.BROWSER_EXECUTABLE_PATH || '',
        };
    }

    /** Replaces every ${VAR} in `str` with process.env[VAR], a default, or ''. */
    _resolveVars(str) {
        if (typeof str !== 'string' || !str.includes('${')) return str;
        const defaults = this._varDefaults();
        return str.replace(VAR_RE, (_, key) => process.env[key] ?? defaults[key] ?? '');
    }

    /**
     * Returns the missing ${VAR} placeholders ONLY when the server is fully
     * unconfigured — i.e. not a single placeholder resolves to a value. That
     * keeps the prior behavior for partially-configured servers where the
     * server has its own defaults and would otherwise spawn fine.
     * OPTIONAL_VARS (DATA_DIR, BROWSER_EXECUTABLE_PATH) never count as
     * missing, so the browser server starts on a dev box with neither set.
     * Returns [] when the server should still be attempted.
     */
    _findMissingEnvVars(serverConfig) {
        const missing = new Set();
        let present = 0;
        const check = (val) => {
            if (typeof val !== 'string') return;
            for (const m of val.matchAll(VAR_RE)) {
                if (OPTIONAL_VARS.includes(m[1])) continue;
                if (process.env[m[1]]) present++;
                else missing.add(m[1]);
            }
        };
        if (serverConfig.env) Object.values(serverConfig.env).forEach(check);
        if (Array.isArray(serverConfig.args)) serverConfig.args.forEach(check);
        if (serverConfig.url) check(serverConfig.url);
        return present === 0 && missing.size > 0 ? [...missing] : [];
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

        if (this._migrateConfig(userConfig, defaultConfig)) dirty = true;

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

        this._slimSkipped.clear();

        for (const [name, serverConfig] of Object.entries(config)) {
            if (serverConfig.disabled) continue;

            const missing = this._findMissingEnvVars(serverConfig);
            if (missing.length > 0) {
                this._slimSkipped.set(name, missing);
                console.log(`[MCP] '${name}' disabled: missing env ${missing.join(', ')}`);
                continue;
            }

            await this._connectServer(name, serverConfig);
        }

        // Initial Tool Cache Population
        await this._refreshToolCache();
    }

    /**
     * Environment for one stdio MCP child: a fixed base (see MCP_BASE_ENV_VARS)
     * plus the variables this server's own config block names, with ${VAR}
     * placeholders resolved from the agent's environment. The agent's own
     * credentials stay in the agent process, so a server that was never given
     * a provider key cannot read one.
     * MCP_ENV_PASSTHROUGH (names separated by commas or spaces) adds variables
     * to the base for every server, for cases the list does not cover.
     */
    _childEnv(name, serverConfig = {}) {
        const env = {};
        const extra = String(process.env.MCP_ENV_PASSTHROUGH || '').split(/[\s,]+/).filter(Boolean);
        for (const key of [...MCP_BASE_ENV_VARS, ...extra]) {
            if (typeof process.env[key] === 'string') env[key] = process.env[key];
        }
        if (serverConfig.env) {
            for (const [k, v] of Object.entries(serverConfig.env)) {
                env[k] = this._resolveVars(v);
            }
        }

        // GWS CLI token cache isolation: each GWS account gets its own HOME
        // directory so the CLI doesn't share cached OAuth tokens between accounts.
        // Without this, the second GWS server reuses the first's cached tokens
        // and returns the wrong account's data for ALL tools (not just calendar).
        if (name.startsWith('gws_')) {
            const dataDir = path.dirname(this.configPath); // /app/data
            const gwsHome = path.join(dataDir, `gws-home-${name}`);
            if (!fs.existsSync(gwsHome)) {
                fs.mkdirSync(gwsHome, { recursive: true });
            }
            env.HOME = gwsHome;
            console.log(`[MCP] GWS cache isolation: ${name} HOME=${gwsHome}`);
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

        return env;
    }


    /** Spawns (or connects to) one server and stores its client. Returns true on success. */
    async _connectServer(name, serverConfig) {
        try {
            console.log(`[MCP] Connecting to server: ${name}...`);

            const env = this._childEnv(name, serverConfig);

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
                    args: (serverConfig.args || []).map(a => this._resolveVars(a)),
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
            return true;

        } catch (error) {
            console.error(`[MCP] Failed to connect to ${name}:`, error);
            return false;
        }
    }

    /** Closes one client and forgets it. */
    async _closeClient(name) {
        const client = this.clients.get(name);
        if (!client) return;
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
        this.clients.delete(name);
    }

    /** True while a tool call to `serverName` is in flight. */
    isServerBusy(serverName) {
        for (const ac of this._activeAbortControllers) {
            if (ac.serverName === serverName) return true;
        }
        return false;
    }

    /**
     * Closes one server, spawns it again and refreshes the tool cache.
     * For stdio servers this kills the child (the browser server takes Chromium
     * with it), so while a call to that server is in flight the restart waits
     * for the call to finish. Only one restart per server runs at a time: a
     * second caller joins the one in progress instead of spawning a second
     * child (which would leave the first as an orphan holding the CDP port
     * and the profile lock). Returns { restarted } or { deferred }.
     */
    async restartServer(name) {
        const serverConfig = this.config?.[name];
        if (!serverConfig) throw new Error(`Unknown MCP server: ${name}`);
        const inProgress = this._restarting.get(name);
        if (inProgress) return inProgress;
        if (this.isServerBusy(name)) {
            this._pendingRestarts.add(name);
            console.log(`[MCP] restart of ${name} deferred: a call is in flight`);
            return { deferred: true };
        }
        this._pendingRestarts.delete(name);
        const run = this._doRestart(name, serverConfig).finally(() => this._restarting.delete(name));
        this._restarting.set(name, run);
        return run;
    }

    async _doRestart(name, serverConfig) {
        await this._closeClient(name);
        if (serverConfig.disabled) return { restarted: false, disabled: true };
        const ok = await this._connectServer(name, serverConfig);
        await this._refreshToolCache();
        console.log(`[MCP] ${name} restarted (${ok ? 'connected' : 'failed'})`);
        return { restarted: ok };
    }

    /** True while restartServer(name) is running. */
    isServerRestarting(name) {
        return this._restarting.has(name);
    }

    _runPendingRestart(serverName) {
        if (!this._pendingRestarts.has(serverName) || this.isServerBusy(serverName)) return;
        this.restartServer(serverName).catch(e => console.error(`[MCP] deferred restart of ${serverName} failed:`, e.message));
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
                    const serverTools = this._filterServerTools(name, result.tools, this.config?.[name]);
                    const mappedTools = serverTools.map(t => {
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

    /**
     * Upgrades a saved config in place. Returns true if anything changed.
     * - Tool filters (includeTools/excludeTools) live in the image's default
     *   config; carry them to saved entries that don't set their own, since
     *   the merge above only adds whole servers that are missing.
     * - GWS entries saved with "-s all" move to GWS_MCP_SERVICES.
     * - The old 'browser-use' entry goes away. A saved 'browser' entry whose
     *   args do not name the launcher stub is the old Deedee server; it is
     *   replaced by the default (or dropped when there is no default). Without
     *   this the merge above keeps the saved entries and never starts the new one.
     */
    _migrateConfig(userConfig, defaultConfig = {}) {
        let changed = false;
        if (userConfig['browser-use']) {
            delete userConfig['browser-use'];
            changed = true;
            console.log('[MCP] removed the retired browser-use server from the saved config');
        }
        const browser = userConfig.browser;
        if (browser && !(Array.isArray(browser.args) && browser.args.some(a => String(a).includes(BROWSER_LAUNCHER)))) {
            if (defaultConfig.browser) {
                userConfig.browser = JSON.parse(JSON.stringify(defaultConfig.browser));
                console.log('[MCP] replaced the old browser server entry with the @playwright/mcp default');
            } else {
                delete userConfig.browser;
                console.log('[MCP] removed the old browser server entry (no default to replace it)');
            }
            changed = true;
        }
        for (const [key, def] of Object.entries(defaultConfig)) {
            const saved = userConfig[key];
            if (!saved || !def) continue;
            for (const field of ['includeTools', 'excludeTools']) {
                if (def[field] && !saved[field]) {
                    saved[field] = def[field];
                    changed = true;
                }
            }
        }
        for (const [key, saved] of Object.entries(userConfig)) {
            if (!key.startsWith('gws_') || !Array.isArray(saved?.args)) continue;
            const i = saved.args.findIndex(a => a === '-s' || a === '--services');
            if (i !== -1 && saved.args[i + 1] === 'all') {
                saved.args[i + 1] = GWS_MCP_SERVICES;
                changed = true;
                console.log(`[MCP] ${key}: narrowed services from "all" to ${GWS_MCP_SERVICES}`);
            }
        }
        return changed;
    }

    /**
     * Applies a server's includeTools/excludeTools (names or "*" globs, matched
     * against the server's own tool names). If includeTools matches nothing,
     * the list is probably stale for this server version, so keep every tool.
     */
    _filterServerTools(name, tools, serverConfig = {}) {
        let kept = tools;
        const include = serverConfig?.includeTools;
        if (Array.isArray(include) && include.length > 0) {
            const res = include.map(_toolPatternToRegex);
            const matched = tools.filter(t => res.some(re => re.test(t.name)));
            if (matched.length > 0) {
                kept = matched;
            } else {
                console.warn(`[MCP] ${name}: includeTools matched none of ${tools.length} tools; keeping all.`);
            }
        }
        const exclude = serverConfig?.excludeTools;
        if (Array.isArray(exclude) && exclude.length > 0) {
            const res = exclude.map(_toolPatternToRegex);
            kept = kept.filter(t => !res.some(re => re.test(t.name)));
        }
        if (kept.length !== tools.length) {
            console.log(`[MCP] ${name}: exposing ${kept.length} of ${tools.length} tools.`);
        }
        return kept;
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

            if (this._slimSkipped.has(name)) {
                statuses.push({ name, status: 'missing-env', missing: this._slimSkipped.get(name) });
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

    async callTool(name, args, { signal } = {}) {
        // Linear lookup removed. Using cache.
        let owner = this.toolMap.get(name);

        // toolMap still points at the old client while its server restarts;
        // wait for the new one instead of failing with "Not connected".
        if (owner && this._restarting.has(owner.name)) {
            await this._restarting.get(owner.name).catch(() => {});
            owner = this.toolMap.get(name);
        }

        if (!owner) {
            // Try refresh once just in case
            await this._refreshToolCache();
            owner = this.toolMap.get(name);
            if (!owner) {
                throw new Error(`Tool ${name} not found in any MCP server.`);
            }
        }

        try {
            return await this._callClient(owner.client, owner.originalName || name, args, signal, owner.name);
        } catch (e) {
            // A dead child (crash, killed) leaves a closed transport. Respawn once and retry.
            if (!this._isClosedTransportError(e) || signal?.aborted) throw e;
            console.warn(`[MCP] ${owner.name} transport closed during ${name}; restarting once`);
            const r = await this.restartServer(owner.name);
            const again = this.toolMap.get(name);
            if (!r.restarted || !again) throw e;
            return await this._callClient(again.client, again.originalName || name, args, signal, again.name);
        }
    }

    _isClosedTransportError(e) {
        const msg = String(e?.message || e || '').toLowerCase();
        return msg.includes('not connected') || msg.includes('transport closed') || msg.includes('connection closed') || msg.includes('epipe');
    }

    /**
     * Cancel every in-flight MCP tool call.
     * Called when the agent receives a stop request, so a long browser step ends at once.
     */
    cancelActiveCalls() {
        if (this._activeAbortControllers.size === 0) return;
        console.log(`[MCP] Cancelling ${this._activeAbortControllers.size} active call(s)...`);
        for (const ac of this._activeAbortControllers) {
            try { ac.abort('Stop requested by user'); } catch {}
        }
        this._activeAbortControllers.clear();
    }

    async _callClient(client, name, args, externalSignal, serverName = null) {
        // Per-server call timeout (`callTimeoutMs` in mcp_config.json); the SDK default is 60s.
        const configured = serverName ? this.config?.[serverName]?.callTimeoutMs : undefined;
        const timeout = Number.isFinite(configured) && configured > 0 ? configured : undefined;

        // Every call gets an AbortController so /stop can cancel it and so
        // restartServer can see which server is busy.
        const ac = new AbortController();
        ac.toolName = name;
        ac.serverName = serverName;
        this._activeAbortControllers.add(ac);
        if (externalSignal) {
            if (externalSignal.aborted) ac.abort(externalSignal.reason);
            else externalSignal.addEventListener('abort', () => ac.abort(externalSignal.reason), { once: true });
        }
        const signal = ac.signal;

        try {
            const options = { signal };
            if (timeout) options.timeout = timeout;

            const result = await client.callTool({
                name: name,
                arguments: args
            }, undefined, options);

            // Let's return the simplified result
            if (result.content && result.content.length > 0) {
                // Text items join into `output`; image items (screenshots) go to
                // `_images` so the agent can send them to the model as inlineData.
                const text = result.content.filter(c => c.type !== 'image').map(c => c.text ?? '').join('\n');
                const returnObj = { output: text };
                const images = result.content
                    .filter(c => c.type === 'image' && c.data)
                    .map(c => ({ mimeType: c.mimeType || 'image/png', data: c.data }));
                if (images.length > 0) returnObj._images = images;
                if (result.isError) returnObj.error = text || 'Tool returned an error.';

                // Extract usage metadata from MCP tool results.
                // Any MCP server can report token usage by including a "usage" field
                // with { model, prompt_tokens, completion_tokens } in its JSON response.
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.usage && parsed.usage.model) {
                        returnObj._meta = {
                            usage: {
                                model: parsed.usage.model,
                                inputTokens: parsed.usage.prompt_tokens || 0,
                                outputTokens: parsed.usage.completion_tokens || 0,
                                tag: parsed.usage.tag || null,
                            }
                        };
                    }
                } catch { /* not JSON or no usage — that's fine */ }

                return returnObj;
            }
            return result;
        } finally {
            this._activeAbortControllers.delete(ac);
            if (serverName) this._runPendingRestart(serverName);
        }
    }



    async close() {
        console.log('[MCP] Closing connections...');
        // A restart in progress would otherwise spawn a child after this loop.
        if (this._restarting.size > 0) await Promise.allSettled([...this._restarting.values()]);
        for (const name of [...this.clients.keys()]) {
            await this._closeClient(name);
        }
        this.clients.clear();
    }
}

module.exports = { MCPManager, GWS_MCP_SERVICES, OPTIONAL_VARS, BROWSER_LAUNCHER, MCP_BASE_ENV_VARS };
