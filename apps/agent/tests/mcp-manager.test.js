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
        // browser-use scenario: GOOGLE_API_KEY set, optional vars unset.
        // The server has its own defaults — preserve prior spawn behavior.
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
