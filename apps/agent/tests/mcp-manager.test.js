const { MCPManager } = require('../src/mcp-manager');

describe('MCPManager._findMissingEnvVars', () => {
    let manager;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        manager = new MCPManager();
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    test('returns missing list when no placeholder resolves', () => {
        delete process.env.HA_URL;
        delete process.env.HA_TOKEN;
        const result = manager._findMissingEnvVars({
            env: { HA_URL: '${HA_URL}', HA_TOKEN: '${HA_TOKEN}' }
        });
        expect(result.sort()).toEqual(['HA_TOKEN', 'HA_URL']);
    });

    test('returns [] when at least one placeholder resolves (partial config)', () => {
        // One var set, the rest unset. The server has its own defaults, so
        // it still spawns.
        process.env.GOOGLE_API_KEY = 'present';
        delete process.env.WORKER_FLASH;
        delete process.env.BROWSER_EXECUTABLE_PATH;
        const result = manager._findMissingEnvVars({
            env: {
                GOOGLE_API_KEY: '${GOOGLE_API_KEY}',
                WORKER_FLASH: '${WORKER_FLASH}',
                BROWSER_EXECUTABLE_PATH: '${BROWSER_EXECUTABLE_PATH}'
            }
        });
        expect(result).toEqual([]);
    });

    test('returns [] when server has no env or url placeholders', () => {
        expect(manager._findMissingEnvVars({})).toEqual([]);
        expect(manager._findMissingEnvVars({ env: {} })).toEqual([]);
        expect(manager._findMissingEnvVars({ env: { FOO: 'literal-value' } })).toEqual([]);
    });

    test('considers SSE url placeholders alongside env', () => {
        delete process.env.SSE_HOST;
        delete process.env.SSE_TOKEN;
        const result = manager._findMissingEnvVars({
            url: 'https://${SSE_HOST}/mcp',
            env: { TOKEN: '${SSE_TOKEN}' }
        });
        expect(result.sort()).toEqual(['SSE_HOST', 'SSE_TOKEN']);
    });

    test('partial config still returns [] when some env-vars are blank but url placeholder resolves', () => {
        process.env.SSE_HOST = 'host.example';
        delete process.env.SSE_TOKEN;
        const result = manager._findMissingEnvVars({
            url: 'https://${SSE_HOST}/mcp',
            env: { TOKEN: '${SSE_TOKEN}' }
        });
        expect(result).toEqual([]);
    });
});

describe('MCPManager config migration and tool filters', () => {
    const { GWS_MCP_SERVICES } = require('../src/mcp-manager');
    let manager;

    beforeEach(() => {
        manager = new MCPManager();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    test('narrows saved gws servers from "-s all" to the scoped services', () => {
        const saved = { gws_work: { command: 'gws', args: ['mcp', '-s', 'all', '--tool-mode', 'compact'] } };
        expect(manager._migrateConfig(saved, {})).toBe(true);
        expect(saved.gws_work.args).toEqual(['mcp', '-s', GWS_MCP_SERVICES, '--tool-mode', 'compact']);
        expect(manager._migrateConfig(saved, {})).toBe(false);
    });

    test('copies tool filters from defaults without overriding saved ones', () => {
        const defaults = { homeassistant: { includeTools: ['ha_get_*'] }, plex: { excludeTools: ['x'] } };
        const saved = { homeassistant: { command: 'ha-mcp' }, plex: { excludeTools: ['mine'] } };
        expect(manager._migrateConfig(saved, defaults)).toBe(true);
        expect(saved.homeassistant.includeTools).toEqual(['ha_get_*']);
        expect(saved.plex.excludeTools).toEqual(['mine']);
    });

    test('includeTools/excludeTools filter by name and glob', () => {
        const tools = ['ha_get_state', 'ha_get_history', 'ha_call_service', 'ha_restart'].map(name => ({ name }));
        const kept = manager._filterServerTools('homeassistant', tools, { includeTools: ['ha_get_*', 'ha_call_service'], excludeTools: ['ha_get_history'] });
        expect(kept.map(t => t.name)).toEqual(['ha_get_state', 'ha_call_service']);
    });

    test('an includeTools list that matches nothing keeps every tool', () => {
        const tools = [{ name: 'a' }, { name: 'b' }];
        expect(manager._filterServerTools('s', tools, { includeTools: ['zzz_*'] })).toHaveLength(2);
    });
});

describe('MCPManager ${VAR} substitution and optional vars', () => {
    const { OPTIONAL_VARS } = require('../src/mcp-manager');
    let manager;
    const originalEnv = { ...process.env };

    beforeEach(() => { manager = new MCPManager(); });
    afterEach(() => { process.env = { ...originalEnv }; });

    test('_resolveVars expands env values and leaves plain strings alone', () => {
        process.env.DATA_DIR = '/tmp/dd';
        expect(manager._resolveVars('${DATA_DIR}/browser_profile/chromium')).toBe('/tmp/dd/browser_profile/chromium');
        expect(manager._resolveVars('--headless')).toBe('--headless');
        expect(manager._resolveVars(42)).toBe(42);
    });

    test('_resolveVars falls back to a default for DATA_DIR and empty for unknown vars', () => {
        delete process.env.DATA_DIR;
        delete process.env.BROWSER_EXECUTABLE_PATH;
        delete process.env.NOPE_NOT_SET;
        const dataDir = manager._resolveVars('${DATA_DIR}');
        expect(dataDir.endsWith('data')).toBe(true);
        expect(manager._resolveVars('${BROWSER_EXECUTABLE_PATH}')).toBe('');
        expect(manager._resolveVars('x${NOPE_NOT_SET}y')).toBe('xy');
    });

    test('DATA_DIR and BROWSER_EXECUTABLE_PATH never count as missing', () => {
        delete process.env.DATA_DIR;
        delete process.env.BROWSER_EXECUTABLE_PATH;
        expect(OPTIONAL_VARS).toEqual(expect.arrayContaining(['DATA_DIR', 'BROWSER_EXECUTABLE_PATH']));
        const result = manager._findMissingEnvVars({
            args: ['scripts/browser-mcp.js', '--user-data-dir', '${DATA_DIR}/browser_profile/chromium'],
            env: { PLAYWRIGHT_MCP_EXECUTABLE_PATH: '${BROWSER_EXECUTABLE_PATH}', DATA_DIR: '${DATA_DIR}' }
        });
        expect(result).toEqual([]);
    });

    test('placeholders in args count towards missing vars', () => {
        delete process.env.ONLY_IN_ARGS;
        expect(manager._findMissingEnvVars({ args: ['--token', '${ONLY_IN_ARGS}'] })).toEqual(['ONLY_IN_ARGS']);
    });
});

describe('MCPManager browser config migration', () => {
    const { BROWSER_LAUNCHER } = require('../src/mcp-manager');
    let manager;
    const defaults = {
        browser: { command: 'node', args: ['scripts/browser-mcp.js', '--headless'], excludeTools: ['browser_close'] }
    };

    beforeEach(() => {
        manager = new MCPManager();
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test('drops a saved browser-use entry', () => {
        const saved = { 'browser-use': { command: 'python3', args: ['server.py'] } };
        expect(manager._migrateConfig(saved, {})).toBe(true);
        expect(saved['browser-use']).toBeUndefined();
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('browser-use'));
    });

    test('replaces a saved browser entry that does not run the launcher stub', () => {
        const saved = { browser: { command: 'node', args: ['index.js'], cwd: '../../packages/mcp-servers/browser', env: { GOOGLE_API_KEY: 'x' } } };
        expect(manager._migrateConfig(saved, defaults)).toBe(true);
        expect(saved.browser).toEqual(defaults.browser);
        expect(saved.browser).not.toBe(defaults.browser); // a copy, not the default object
        expect(saved.browser.args.some(a => a.includes(BROWSER_LAUNCHER))).toBe(true);
    });

    test('removes a stale browser entry when no default exists', () => {
        const saved = { browser: { command: 'node', args: ['index.js'] } };
        expect(manager._migrateConfig(saved, {})).toBe(true);
        expect(saved.browser).toBeUndefined();
    });

    test('keeps a saved browser entry that already runs the launcher stub', () => {
        const saved = { browser: { command: 'node', args: ['scripts/browser-mcp.js', '--headless'], excludeTools: ['browser_close'], disabled: true } };
        expect(manager._migrateConfig(saved, defaults)).toBe(false);
        expect(saved.browser.disabled).toBe(true);
    });
});

describe('MCPManager._callClient', () => {
    let manager;

    function fakeClient(result, onCall) {
        return {
            callTool: jest.fn(async (req, _schema, options) => {
                if (onCall) await onCall(req, options);
                return typeof result === 'function' ? result(req, options) : result;
            })
        };
    }

    beforeEach(() => {
        manager = new MCPManager();
        manager.config = { browser: { callTimeoutMs: 120000 }, plex: {} };
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test('joins text items and collects image items into _images', async () => {
        const client = fakeClient({
            content: [
                { type: 'text', text: '### Page\n- heading "Hi"' },
                { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
                { type: 'text', text: 'done' }
            ]
        });
        const r = await manager._callClient(client, 'browser_take_screenshot', {}, undefined, 'browser');
        expect(r.output).toBe('### Page\n- heading "Hi"\ndone');
        expect(r._images).toEqual([{ mimeType: 'image/jpeg', data: 'AAAA' }]);
        expect(r.error).toBeUndefined();
    });

    test('no image items means no _images key', async () => {
        const client = fakeClient({ content: [{ type: 'text', text: 'ok' }] });
        const r = await manager._callClient(client, 'plex_play', {}, undefined, 'plex');
        expect(r).toEqual({ output: 'ok' });
    });

    test('passes the per-server callTimeoutMs and none when unset', async () => {
        const seen = [];
        const client = fakeClient({ content: [{ type: 'text', text: 'ok' }] }, (_req, options) => { seen.push(options); });
        await manager._callClient(client, 'browser_navigate', { url: 'x' }, undefined, 'browser');
        await manager._callClient(client, 'plex_play', {}, undefined, 'plex');
        expect(seen[0].timeout).toBe(120000);
        expect(seen[0].signal).toBeInstanceOf(AbortSignal);
        expect(seen[1].timeout).toBeUndefined();
    });

    test('isError sets error and cancelActiveCalls aborts the signal', async () => {
        let captured;
        const client = fakeClient(
            { isError: true, content: [{ type: 'text', text: 'boom' }] },
            (_req, options) => { captured = options.signal; expect(manager.isServerBusy('browser')).toBe(true); }
        );
        const r = await manager._callClient(client, 'browser_click', {}, undefined, 'browser');
        expect(r.error).toBe('boom');
        expect(manager.isServerBusy('browser')).toBe(false);
        expect(captured.aborted).toBe(false);

        // Now a call that is still in flight when /stop arrives.
        let release;
        const slow = fakeClient({ content: [] }, (_req, options) => new Promise(res => {
            release = res;
            options.signal.addEventListener('abort', () => res());
        }));
        const p = manager._callClient(slow, 'browser_wait_for', {}, undefined, 'browser');
        await new Promise(r => setImmediate(r));
        expect(manager.isServerBusy('browser')).toBe(true);
        manager.cancelActiveCalls();
        await p;
        expect(manager._activeAbortControllers.size).toBe(0);
        if (release) release();
    });
});

describe('MCPManager.restartServer', () => {
    let manager;

    beforeEach(() => {
        manager = new MCPManager();
        manager.config = { browser: { command: 'node', args: [] } };
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(manager, '_closeClient').mockResolvedValue();
        jest.spyOn(manager, '_connectServer').mockResolvedValue(true);
        jest.spyOn(manager, '_refreshToolCache').mockResolvedValue();
    });
    afterEach(() => jest.restoreAllMocks());

    test('closes, respawns and refreshes the tool cache', async () => {
        const r = await manager.restartServer('browser');
        expect(r).toEqual({ restarted: true });
        expect(manager._closeClient).toHaveBeenCalledWith('browser');
        expect(manager._connectServer).toHaveBeenCalledWith('browser', manager.config.browser);
        expect(manager._refreshToolCache).toHaveBeenCalled();
    });

    test('rejects unknown servers', async () => {
        await expect(manager.restartServer('nope')).rejects.toThrow('Unknown MCP server');
    });

    test('defers while a call to that server is in flight, then runs after it ends', async () => {
        let finish;
        const client = { callTool: () => new Promise(res => { finish = res; }) };
        const p = manager._callClient(client, 'browser_navigate', {}, undefined, 'browser');
        await new Promise(r => setImmediate(r));

        const r = await manager.restartServer('browser');
        expect(r).toEqual({ deferred: true });
        expect(manager._connectServer).not.toHaveBeenCalled();

        finish({ content: [{ type: 'text', text: 'ok' }] });
        await p;
        await new Promise(r => setImmediate(r));
        expect(manager._connectServer).toHaveBeenCalledTimes(1);
        expect(manager._pendingRestarts.has('browser')).toBe(false);
    });
});
